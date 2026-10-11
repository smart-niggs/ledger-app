-- Up Migration

CREATE TABLE accounts (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        TEXT        NOT NULL CHECK (type IN ('user', 'system')),
  currency    TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     BIGINT      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_overdraft CHECK (type = 'system' OR balance >= 0)
);

CREATE TABLE transactions (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  BIGINT      NOT NULL REFERENCES transactions (id),
  account_id      BIGINT      NOT NULL REFERENCES accounts (id),
  amount          BIGINT      NOT NULL CHECK (amount <> 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);
CREATE INDEX entries_account_id_idx     ON entries (account_id);

-- Protection 3: a transaction's entries must sum to zero, in a single currency.
-- Checked at COMMIT, not at INSERT, so the intermediate one-sided state is legal.
CREATE FUNCTION assert_transaction_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  total          BIGINT;
  currency_count INT;
BEGIN
  SELECT COALESCE(SUM(e.amount), 0), COUNT(DISTINCT a.currency)
    INTO total, currency_count
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
   WHERE e.transaction_id = NEW.transaction_id;

  IF currency_count > 1 THEN
    RAISE EXCEPTION 'transaction % mixes currencies', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % is unbalanced: entries sum to %',
      NEW.transaction_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_transaction_balanced();

-- Protection 4: entries are append-only.
CREATE FUNCTION entries_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'entries are append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER entries_no_update_or_delete
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION entries_append_only();

CREATE TRIGGER entries_no_truncate
  BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION entries_append_only();

-- Down Migration

DROP TRIGGER IF EXISTS entries_no_truncate          ON entries;
DROP TRIGGER IF EXISTS entries_no_update_or_delete  ON entries;
DROP TRIGGER IF EXISTS entries_balanced             ON entries;
DROP FUNCTION IF EXISTS entries_append_only();
DROP FUNCTION IF EXISTS assert_transaction_balanced();
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS accounts;