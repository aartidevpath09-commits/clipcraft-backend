-- 004_uuid_ids.sql
-- Migrate users.id and projects.id from INTEGER to UUID
-- while preserving all existing users, accounts and projects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Temporary UUIDs for existing users
ALTER TABLE users
ADD COLUMN uuid_id UUID DEFAULT gen_random_uuid();

UPDATE users
SET uuid_id = gen_random_uuid()
WHERE uuid_id IS NULL;

ALTER TABLE users
ALTER COLUMN uuid_id SET NOT NULL;

CREATE UNIQUE INDEX users_uuid_id_unique ON users(uuid_id);

-- Temporary UUIDs for existing projects
ALTER TABLE projects
ADD COLUMN uuid_id UUID DEFAULT gen_random_uuid();

UPDATE projects
SET uuid_id = gen_random_uuid()
WHERE uuid_id IS NULL;

ALTER TABLE projects
ALTER COLUMN uuid_id SET NOT NULL;

CREATE UNIQUE INDEX projects_uuid_id_unique ON projects(uuid_id);

-- Temporary UUID foreign-key columns
ALTER TABLE accounts
ADD COLUMN uuid_user_id UUID;

ALTER TABLE projects
ADD COLUMN uuid_user_id UUID;

-- Map existing relationships using the old integer IDs
UPDATE accounts a
SET uuid_user_id = u.uuid_id
FROM users u
WHERE a.user_id = u.id;

UPDATE projects p
SET uuid_user_id = u.uuid_id
FROM users u
WHERE p.user_id = u.id;

-- Safety checks: every existing relationship must have mapped
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM accounts WHERE uuid_user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'UUID migration failed: account user mapping missing';
    END IF;

    IF EXISTS (
        SELECT 1 FROM projects WHERE uuid_user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'UUID migration failed: project user mapping missing';
    END IF;
END $$;

-- Remove existing foreign keys
ALTER TABLE accounts
DROP CONSTRAINT fk_accounts_user;

ALTER TABLE projects
DROP CONSTRAINT fk_projects_user;

-- Remove old primary keys
ALTER TABLE users
DROP CONSTRAINT users_pkey;

ALTER TABLE projects
DROP CONSTRAINT projects_pkey;

-- Remove old unique constraint on accounts.user_id
ALTER TABLE accounts
DROP CONSTRAINT accounts_user_id_key;

-- Replace old IDs with UUID IDs
ALTER TABLE users
RENAME COLUMN id TO legacy_id;

ALTER TABLE users
RENAME COLUMN uuid_id TO id;

ALTER TABLE projects
RENAME COLUMN id TO legacy_id;

ALTER TABLE projects
RENAME COLUMN uuid_id TO id;

-- Replace old integer user references
ALTER TABLE accounts
RENAME COLUMN user_id TO legacy_user_id;

ALTER TABLE accounts
RENAME COLUMN uuid_user_id TO user_id;

ALTER TABLE projects
RENAME COLUMN user_id TO legacy_user_id;

ALTER TABLE projects
RENAME COLUMN uuid_user_id TO user_id;

-- Make UUID IDs the primary keys
ALTER TABLE users
ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE projects
ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

-- Restore required uniqueness and foreign keys
ALTER TABLE accounts
ADD CONSTRAINT accounts_user_id_key UNIQUE (user_id);

ALTER TABLE accounts
ADD CONSTRAINT fk_accounts_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

ALTER TABLE projects
ADD CONSTRAINT fk_projects_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

-- Remove legacy integer columns after successful mapping
ALTER TABLE users DROP COLUMN legacy_id;
ALTER TABLE projects DROP COLUMN legacy_id;
ALTER TABLE accounts DROP COLUMN legacy_user_id;
ALTER TABLE projects DROP COLUMN legacy_user_id;

-- UUID defaults for future records
ALTER TABLE users
ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE projects
ALTER COLUMN id SET DEFAULT gen_random_uuid();

COMMIT;