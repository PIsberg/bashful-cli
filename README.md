# Bashful

A CLI-to-REST Auto-Wrapper that dynamically generates a REST API from a command-line tool's `--help` output.

Bashful parses the `--help` output of any CLI tool, extracts its arguments and flags, and spins up a local REST API that you can use to execute the tool via HTTP requests.

## Prerequisites

- Bun (v1.0+ recommended)

## How to Run

1. Install dependencies (if not already done):

Linux
   ```bash
   bun install
   ```
Windows
 ```powershell -c "irm bun.sh/install.ps1 | iex"   
```

2. Start Bashful by passing the command you want to wrap. For example, to wrap `curl`:
   ```bash
   bun run start
   ```
   Or manually:
   ```bash
   bun run bashful.ts pipe curl --help
   ```
   *Note: `pipe <command> --help` is used to explicitly pass the help text command.*

3. The server will start on port 3000.


### Test

 Invoke-WebRequest -Uri http://localhost:3000/curl -Method POST -ContentType "application/json" -Body '{"_args": ["http://example.com"]}'

  Or prefix with !  to run it in the bash shell:

  ! curl -X POST http://localhost:3000/curl -H "Content-Type: application/json" -d '{"_args": ["http://example.com"]}'

### Debugging

To enable logging (including startup time, parsed schema, and execution details), pass the `--debug` flag when starting Bashful:

```bash
bun run bashful.ts --debug pipe curl --help
```

## Usage

Once the server is running, you can interact with it via HTTP.

### 1. Web UI (Swagger-like)

You can access a dynamically generated, simplistic UI to interact with the command directly from your browser.

Open your browser and navigate to:
```
http://localhost:3000/
```

### 2. View the Generated Schema

Get the parsed schema of the CLI tool's arguments:

```bash
curl http://localhost:3000/curl/schema
```

### 2. Execute the Command

Send a POST request with a JSON payload containing the flags and arguments you want to pass to the tool.

```bash
curl -X POST http://localhost:3000/curl \
  -H "Content-Type: application/json" \
  -d '{
    "silent": true,
    "output": "example.html",
    "_args": ["http://example.com"]
  }'
```

This will execute: `curl --silent --output example.html http://example.com`

- Use `_args` for positional arguments.
- Boolean flags (e.g., `"silent": true`) will be passed as `--silent`.
- Key-value flags (e.g., `"output": "example.html"`) will be passed as `--output example.html`.

## Architecture

- **Ingestion**: Executes `<command> --help` and captures the output.
- **Schema Synthesis**: Uses a heuristic regex to parse short flags, long flags, types, and descriptions into a JSON schema.
- **Dynamic Scaffolding**: Spins up a Node.js HTTP server.
- **Execution**: Translates incoming JSON payloads back into CLI arguments and executes them using `child_process.spawn`.
