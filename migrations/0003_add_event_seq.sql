-- 修复 events hash chain 并发分叉:给每 task 的事件加单调 seq,
-- appendEvent 以 (MAX(seq)+1, prev) 做乐观 CAS,冲突重试,杜绝 sibling 分叉。

ALTER TABLE events ADD COLUMN seq INTEGER;

-- 回填存量:按 (created_at, rowid) 顺序赋连续 seq(created_at 是秒级,rowid 做 tiebreaker)
UPDATE events SET seq = (
  SELECT COUNT(*) FROM events AS e2
  WHERE e2.task_id = events.task_id
    AND (e2.created_at < events.created_at
         OR (e2.created_at = events.created_at AND e2.rowid <= events.rowid))
);

CREATE UNIQUE INDEX idx_events_task_seq ON events(task_id, seq);
