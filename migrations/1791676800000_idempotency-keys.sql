-- Up Migration

CREATE TABLE idempotency_keys (
  key             TEXT        PRIMARY KEY,
  request_hash    TEXT        NOT NULL,
  transaction_id  BIGINT      REFERENCES transactions (id),
  response_code   INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS idempotency_keys;