# Local Test Stack

This directory contains a minimal local SEB Server test setup.

Ports:
- `18080`: SEB Server HTTP
- `13306`: MariaDB

Default admin login:
- Username: `admin`
- Password: `admin`

Build the jar in the repository root before starting the stack:

```bash
docker run --rm -v "$PWD":/workspace -w /workspace maven:3.9-eclipse-temurin-17 mvn -DskipTests package
cp target/seb-server-2.2.3.jar seb-server.jar
docker compose -f local-test/docker-compose.yml up --build -d
```

If you need a clean local database after changing config or migrations:

```bash
docker compose -f local-test/docker-compose.yml down -v
```
