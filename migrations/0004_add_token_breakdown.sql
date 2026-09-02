-- attempt 的 token 台账改诚实:tokens_used(raw total)之外补记用量四元组拆分与
-- 成本加权值。r11 writer 实测 total 6,949,711 里有 6,733,762(96.9%)是隐式 prompt
-- 缓存命中 —— 把 total 当成本口径会把最便宜的 token 与最贵的按同价计。
--
-- 刻意不给 DEFAULT 0:旧行 NULL 的含义是「当时未记录」,与「记录到 0」是两回事。
-- 成本口径自此以 cost_weighted_tokens 为准,tokens_used 只作历史可比参考。

ALTER TABLE attempts ADD COLUMN input_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN output_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN cost_weighted_tokens INTEGER;
