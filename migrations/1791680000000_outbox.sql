-- Up Migration

CREATE TABLE outbox (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  transaction_id  BIGINT      REFERENCES transactions (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  attempts        INT         NOT NULL DEFAULT 0,
  last_error      TEXT
);

-- Partial index: the worker only ever asks for unprocessed rows, so the index
-- stays small no matter how many events have already been delivered.
CREATE INDEX outbox_unprocessed_idx ON outbox (id) WHERE processed_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS outbox;
