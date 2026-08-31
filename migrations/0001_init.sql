-- 控制面权威状态 + 审计 journal。执行面(Sandbox/Workflows)的历史一律不作为权威。

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec TEXT NOT NULL,              -- 冻结的任务规格(JSON)
  spec_digest TEXT NOT NULL,       -- sha256(spec),冻结后不可变
  state TEXT NOT NULL,             -- PENDING/RUNNING/AWAITING_APPROVAL/DONE/REJECTED/BLOCKED
  version INTEGER NOT NULL,        -- fencing token:每次权威转换 +1,写入走 CAS
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,              -- writer/reviewer/verifier
  state TEXT NOT NULL,             -- RUNNING/SUCCEEDED/FAILED/BLOCKED
  idempotency_key TEXT NOT NULL UNIQUE,
  proxy_token TEXT UNIQUE,         -- 一次性模型代理凭据(沙箱内只见这个,不见真实 key)
  tokens_used INTEGER NOT NULL DEFAULT 0,
  max_model_tokens INTEGER NOT NULL,
  max_wall_seconds INTEGER NOT NULL,
  workflow_instance_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  actor TEXT NOT NULL,             -- principal:谁(human:xxx / agent:attempt-id / system)
  decision TEXT NOT NULL,          -- approve/reject/block + reason
  evidence_digest TEXT NOT NULL,   -- 决策绑定的证据 manifest digest
  fencing_token INTEGER NOT NULL,  -- 做出决策时持有的 task version
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 追加式事件日志,digest = sha256(prev_digest || canonical(payload)),篡改可检测
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  digest TEXT NOT NULL,
  prev_digest TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
