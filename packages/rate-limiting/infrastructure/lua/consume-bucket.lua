-- Atomic Token Bucket consume script for Redis
-- KEYS[1]: bucket key
-- ARGV[1]: capacity (number)
-- ARGV[2]: refill_rate_per_sec (number)
-- ARGV[3]: requested_tokens (number)
-- ARGV[4]: now_ms (number)
-- ARGV[5]: ttl_seconds (number)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate_per_sec = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "last_refill")
local current_tokens
local last_refill_ms

if data[1] == false or data[1] == nil then
  current_tokens = capacity
  last_refill_ms = now_ms
else
  current_tokens = tonumber(data[1])
  last_refill_ms = tonumber(data[2])

  if now_ms > last_refill_ms then
    local elapsed_ms = now_ms - last_refill_ms
    local refilled = (elapsed_ms / 1000.0) * refill_rate_per_sec
    current_tokens = math.min(capacity, current_tokens + refilled)
    last_refill_ms = now_ms
  end
end

local allowed = 0
local time_to_next_ms = 0

if current_tokens >= requested then
  allowed = 1
  current_tokens = current_tokens - requested
  if current_tokens < capacity then
    local frac = current_tokens % 1
    local needed_for_next = 1.0 - frac
    if needed_for_next <= 0 then
      needed_for_next = 1.0
    end
    time_to_next_ms = math.ceil((needed_for_next / refill_rate_per_sec) * 1000.0)
  else
    time_to_next_ms = 0
  end
else
  allowed = 0
  local deficit = requested - current_tokens
  time_to_next_ms = math.ceil((deficit / refill_rate_per_sec) * 1000.0)
end

redis.call("HMSET", key, "tokens", tostring(current_tokens), "last_refill", tostring(last_refill_ms))
redis.call("EXPIRE", key, ttl_seconds)

return { allowed, tostring(current_tokens), time_to_next_ms }
