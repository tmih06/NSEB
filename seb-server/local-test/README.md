# Local Test Stack

This directory contains a minimal local SEB Server test setup.

Ports:
- `18080`: SEB Server HTTP
- `18180`: Mock exam page
- `13306`: MariaDB

Default admin login:
- Username: `admin`
- Password: `admin`

From the repository root, the fastest way to bring up a clean end-to-end test environment is:

```bash
make serve
```

That target rebuilds `seb-server`, resets the local test database, starts the stack, provisions a running exam, and exports a client connection config to `.serve/local-exam-client.seb`.

To stop and remove the local test stack:

```bash
make serve-down
```

If you need to work with the raw local stack manually instead, build the jar in the repository root before starting it:

```bash
docker run --rm -v "$PWD":/workspace -w /workspace maven:3.9-eclipse-temurin-17 mvn -DskipTests package
cp target/seb-server-2.2.3.jar seb-server.jar
docker compose -f local-test/docker-compose.yml up --build -d
```

If you need a clean local database after changing config or migrations:

```bash
docker compose -f local-test/docker-compose.yml down -v
```
