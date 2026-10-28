# dsh-hindsight-local

Run the [Hindsight](https://github.com/vectorize-io/hindsight) memory server **on your own machine** and load it as a DeepSeek Harness plugin. Memory extraction, embedding, retrieval and knowledge pages all stay local; the LLM is the provider you already pay for (DeepSeek / OpenAI / Anthropic / Ollama / …). Nothing is sent to a hosted memory service.

It is the local counterpart of the official `@vectorize-io/hindsight-coding-agents` plugin: same mental model (one bank per repository, LLM-maintained knowledge pages, per-session injection), but self-hosted and free apart from your own model calls.

## What it does

- **Runs the server**: finds the `hindsight-api` binary already cached by `uv`, probes `/health`, and starts it detached when it is not running (polls until ready, 240 s by default).
- **Injects context**: once per session it adds the repository's knowledge-page index plus a few recalled facts, capped by `injectMaxChars`.
- **Writes memory back**: when a turn goes idle, the latest user/assistant messages are retained into the bank and extracted into structured facts.
- **Gives the model tools**: ten `hindsight_local_*` tools to search and read pages, recall facts, remember, reflect, inspect status/logs, and start/stop the server.

## Install

```bash
dsh plugin --profile desktop add /path/to/dsh-hindsight-local
```

Restart DSH afterwards — the plugin reads its configuration at process start.

### One-time server setup

The plugin does not ship a Python environment and does not run `uvx` inside a session (that is a multi-minute install). Prepare the server once:

```bash
uvx --from hindsight-embed@latest hindsight-embed profile create coding-agent \
  --port 9077 \
  --env HINDSIGHT_API_LLM_PROVIDER=deepseek \
  --env HINDSIGHT_API_LLM_MODEL=deepseek-chat \
  --env HINDSIGHT_API_LLM_BASE_URL=https://api.deepseek.com
```

Then put the key into `~/.hindsight/profiles/coding-agent.env`:

```
HINDSIGHT_API_LLM_API_KEY=sk-...
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_PORT=9077
```

## Configuration

Every field has a default; override only what you need:

```yaml
- id: hindsight-local
  config:
    apiUrl: http://127.0.0.1:9077
    autoStart: true
    profile: coding-agent
    bankTemplate: 'coding-agent::{project}'
    injectPages: true
    recallLimit: 5
    retainOnIdle: true
```

Resolution order: **plugin config → process env → profile env file → built-in defaults**.

## Tools

`hindsight_local_status`, `_start`, `_stop`, `_logs`, `_search`, `_read`, `_recall`, `_remember`, `_reflect`, `_pages`.

## Why not `hindsight-embed daemon start`

That wrapper gives up after a fixed 180 s readiness window, while a cold start installs ~450 MB of dependencies and downloads the embedding/reranker models (3–5 minutes on a real machine). It reports `Daemon Failed (Timeout)` while the process keeps initialising. This plugin launches `hindsight-api` directly and polls `/health` itself.

## Windows notes (handled for you)

- The startup banner contains block characters that crash on a GBK console → `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` are injected.
- `huggingface_hub` (httpx) does not trust the Windows certificate store, so the first model download fails with `CERTIFICATE_VERIFY_FAILED`. Export your Windows roots to `~/.hindsight/winroot.pem` and the plugin uses it for `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`.

## Relationship to the official plugin

Defaults are aligned on purpose (same bank name, same profile), so both plugins read the same memories — but both injecting would duplicate context, so keep only one. The official plugin's daemon mode is skipped on Windows because its last LLM probe is `which claude`; this plugin does not rely on it.

## License

MIT
