
/**
 * Server-side Lua script that performs atomic multi-op mutations on a RedisJSON document.
 *
 * **Do not edit this string without updating the corresponding TypeScript argument-building logic in `mutateAtomically`.**
 *
 * ### KEYS / ARGV layout
 * ```
 * KEYS[1]        - Redis key of the target JSON document
 * ARGV[1]        - Number of operations (opCount)
 * ARGV[2]        - Return mode: "none" | "mutated" | "nonMutated"
 * ARGV[3 to N]   - Flattened operation arguments (see per-op layout below)
 * ```
 *
 * ### Per-operation argument layout
 * | op         | Arguments after op-name                      |
 * |------------|----------------------------------------------|
 * | set        | path, jsonValue                              |
 * | del        | path                                         |
 * | strappend  | path, jsonStringValue                        |
 * | numincrby  | path, numberAsString                         |
 * | nummultby  | path, numberAsString                         |
 * | arrappend  | path, count, jsonValue₁ … jsonValueₙ         |
 * | arrinsert  | path, index, count, jsonValue₁ … jsonValue   |
 * | arrpop     | path, index (optional)                       |
 * | arrtrim    | path, start, stop                            |
 * | toggle     | path                                         |
 * | merge      | path, jsonObjectValue                        |
 *
 * @internal
 */

export const atomicRedisJsonMutationScript = `
local key = KEYS[1]
local opCount = tonumber(ARGV[1])
local returnMode = ARGV[2]

if not opCount then
    error("opCount must be a number")
end

local index = 3

-- =========================================================
-- HELPERS
-- =========================================================

-- Per-script type cache: avoids redundant JSON.TYPE calls for the same path across multiple operations in the same batch.

local typeCache = {}

local function getType(path)

    if typeCache[path] ~= nil then
        return typeCache[path]
    end

    local res = redis.call("JSON.TYPE", key, path)

    if res == nil or res == false then
        return nil
    end

    if type(res) ~= "table" then
        typeCache[path] = res
        return res
    end

    if #res == 0 then
        return nil
    end

    if #res > 1 then
        error("Path matches multiple values: " .. path)
    end

    typeCache[path] = res[1]
    return res[1]
end

local function pathExists(path)
    local res = redis.call("JSON.TYPE", key, path)

    if res == nil or res == false then
        return false
    end

    if type(res) ~= "table" then
        return res ~= false
    end

    return #res > 0
end

local function ensureExists(path)
    if not pathExists(path) then
        return false, "Path does not exist: " .. path
    end

    return true
end

local function ensureNumber(path)
    local ok, err = ensureExists(path)

    if not ok then
        return false, err
    end

    local t = getType(path)

    if t ~= "integer" and t ~= "number" then
        return false, "Path is not numeric: " .. path
    end

    return true
end

local function ensureString(path)
    local ok, err = ensureExists(path)

    if not ok then
        return false, err
    end

    if getType(path) ~= "string" then
        return false, "Path is not string: " .. path
    end

    return true
end

local function ensureArray(path)
    local ok, err = ensureExists(path)

    if not ok then
        return false, err
    end

    if getType(path) ~= "array" then
        return false, "Path is not array: " .. path
    end

    return true
end

local function ensureObject(path)
    local ok, err = ensureExists(path)

    if not ok then
        return false, err
    end

    local t = getType(path)

    if t ~= "object" then
        return false, "Path is not object: " .. path
    end

    return true
end

local function ensureBoolean(path)
    local ok, err = ensureExists(path)

    if not ok then
        return false, err
    end

    if getType(path) ~= "boolean" then
        return false, "Path is not boolean: " .. path
    end

    return true
end

-- =========================================================
-- VALIDATE + EXECUTION
-- =========================================================

-- Taking Snapshot to rollback on error
local errors = {}
local results = {}
local snapshot = redis.call("JSON.GET", key)

for i = 1, opCount do

    local op = ARGV[index]
    local res

    index = index + 1

    -- =====================
    -- SET
    -- =====================

    if op == "set" then

        local path = ARGV[index]
        local value = ARGV[index + 1]

        index = index + 2

        if #errors == 0 then

            -- Invalidate cache: type at this path is about to change
            typeCache[path] = nil

            res = redis.call(
                "JSON.SET",
                key,
                path,
                value
            )
        end
    
    -- =====================
    -- DEL
    -- =====================
    
    elseif op == "del" then
    
        local path = ARGV[index]
        
        index = index + 1
        
        if #errors == 0 then

            -- Invalidate cache: path will no longer exist
            typeCache[path] = nil

            res = redis.call(
                "JSON.DEL",
                key,
                path
            )
        end

    -- =====================
    -- STRAPPEND
    -- =====================

    elseif op == "strappend" then

        local path = ARGV[index]
        local value = ARGV[index + 1]

        index = index + 2

        local ok, err = ensureString(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
            res = redis.call(
                "JSON.STRAPPEND",
                key,
                path,
                value
            )   
        end

    -- =====================
    -- NUMINCRBY
    -- =====================

    elseif op == "numincrby" then

        local path = ARGV[index]
        local value = tonumber(ARGV[index + 1])

        index = index + 2

        local ok, err = ensureNumber(path)

        if not ok then
            table.insert(errors, err)
        end

        if not value then
            table.insert(errors, "Value in numincrby is not a number for path: " .. path)
        end

        if #errors == 0 then
            res = redis.call(
                "JSON.NUMINCRBY",
                key,
                path,
                value
            )
        end

    
    -- =====================
    -- NUMMULTBY
    -- =====================

    elseif op == "nummultby" then

        local path = ARGV[index]
        local value = tonumber(ARGV[index + 1])

        index = index + 2

        local ok, err = ensureNumber(path)

        if not ok then
            table.insert(errors, err)
        end

        if not value then
            table.insert(errors, "Value in nummultby is not a number for path: " .. path)
        end

        if #errors == 0 then
            res = redis.call(
                "JSON.NUMMULTBY",
                key,
                path,
                value
            )
        end

    -- =====================
    -- ARRAPPEND
    -- =====================

    elseif op == "arrappend" then

        local path = ARGV[index]
        local count = tonumber(ARGV[index + 1])

        if not count then
            error("Invalid arrappend count at path: " .. path)
        end

        index = index + 2

        local ok, err = ensureArray(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
        
            local args = { key, path }

            for j = 1, count do
                table.insert(args, ARGV[index])
                index = index + 1
            end

            res = redis.call(
                "JSON.ARRAPPEND",
                unpack(args)
            )
        end

    -- =====================
    -- ARRINSERT
    -- =====================

    elseif op == "arrinsert" then

        local path = ARGV[index]
        local arrIndex = tonumber(ARGV[index + 1])
        local count = tonumber(ARGV[index + 2])

        if not count then
            error("Invalid arrinsert count at path: " .. path)
        end

        if not arrIndex then
            error("Invalid index in arrinsert at path: " .. path)
        end

        index = index + 3

        local ok, err = ensureArray(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
            local args = {
                key,
                path,
                arrIndex
            }

            for j = 1, count do
                table.insert(args, ARGV[index])
                index = index + 1
            end

            res = redis.call(
                "JSON.ARRINSERT",
                unpack(args)
            )
        end
    -- =====================
    -- ARRPOP
    -- =====================

    elseif op == "arrpop" then

        local path = ARGV[index]
        local arrIndex = tonumber(ARGV[index + 1])

        if not arrIndex then
            index = index + 1        
        else
            index = index + 2
        end

        local ok, err = ensureArray(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
            if arrIndex then
                res = redis.call(
                    "JSON.ARRPOP",
                    key,
                    path,
                    arrIndex
                )
            else
                res = redis.call(
                    "JSON.ARRPOP",
                    key,
                    path
                )
            end
        end

    -- =====================
    -- ARRTRIM
    -- =====================

    elseif op == "arrtrim" then

        local path = ARGV[index]
        local start = tonumber(ARGV[index + 1])
        local stop = tonumber(ARGV[index + 2])

        if not start then
            table.insert(errors, "Invalid starting index in arrtrim at path: " .. path)
        end

        if not stop then
            table.insert(errors, "Invalid ending index in arrtrim at path: " .. path)
        end

        index = index + 3

        local ok, err = ensureArray(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
            res = redis.call(
                "JSON.ARRTRIM",
                key,
                path,
                start,
                stop
            )
        end

    -- =====================
    -- TOGGLE
    -- =====================

    elseif op == "toggle" then

        local path = ARGV[index]

        index = index + 1

        local ok, err = ensureBoolean(path)

        if not ok then
            table.insert(errors, err)
        end
        
        if #errors == 0 then
            res = redis.call(
                "JSON.TOGGLE",
                key,
                path
            )
        end

    -- =====================
    -- MERGE
    -- =====================

    elseif op == "merge" then

        local path = ARGV[index]
        local value = ARGV[index + 1]

        index = index + 2

        local ok, err = ensureObject(path)

        if not ok then
            table.insert(errors, err)
        end

        if #errors == 0 then
            res = redis.call(
                "JSON.MERGE",
                key,
                path,
                value
            )
        end

    else
        error("Unknown op: " .. tostring(op))
    end

    if #errors == 0 then
        table.insert(results, res)
    end
end

-- =========================================================
-- Return
-- =========================================================

if #errors > 0 then
    
    -- Rolling back on error
    if snapshot then
        redis.call("JSON.SET", key, "$", snapshot)
    else
        -- if rollback is nill that means the document does not existed before operations
        -- So simply delete the partial operations

        redis.call("JSON.DEL", key)
    end

    return { 0, unpack(errors) }
end

local mutatedDoc = nil

if returnMode == "mutated" then
    return { 1, redis.call("JSON.GET", key) }

elseif returnMode == "nonMutated" then
    return { 1, snapshot }

end

return { 1, results }
`