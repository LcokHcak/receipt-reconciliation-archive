# User Management CLI

Use this tool to create and maintain local RBAC users for the Sign workbench.

## Default Database

By default, commands use:

```powershell
passport_review_workbench\storage\workbench.sqlite
```

Override it with `--db <path>` or `WORKBENCH_DB_PATH`.

## Commands

```powershell
npm run users -- help
npm run users -- list
npm run users -- bootstrap-admin --username admin --password "change-me-123"
npm run users -- create --username reviewer1 --password "secret123" --role reviewer
npm run users -- update-role --username reviewer1 --role finance
npm run users -- reset-password --username reviewer1 --password "new-secret-123"
npm run users -- deactivate --username reviewer1
```

All successful commands print JSON and never include password hashes in public output.

## Roles

- `admin`
- `reviewer`
- `finance`
