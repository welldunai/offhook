"""Admin CLI — bootstrap tenants, API keys, and (for dev) connections + agent.

Run with: ``python -m app.admin <command>``

This resolves the chicken-and-egg of needing an API key to call the authed API:
the first tenant + key are created here. ``seed-dev`` additionally imports the
provider keys already in your environment as that tenant's encrypted
connections and creates a demo agent, giving you a ready end-to-end setup.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import uuid

from dotenv import load_dotenv

load_dotenv()

from app.auth.apikey import generate_key  # noqa: E402
from app.crypto.envelope import encrypt_secret, get_or_create_tenant_dek  # noqa: E402
from app.db.engine import session_scope  # noqa: E402
from app.db.models import Agent, ApiKey, Connection, Tenant  # noqa: E402


async def _create_tenant_and_key(db, name: str, slug: str) -> tuple[Tenant, str]:
    tenant = Tenant(name=name, slug=slug)
    db.add(tenant)
    await db.flush()
    gen = generate_key()
    db.add(ApiKey(tenant_id=tenant.id, prefix=gen.prefix, key_hash=gen.key_hash, name="bootstrap"))
    await db.flush()
    return tenant, gen.full_key


async def _add_connection(db, tenant_id, name, kind, provider, secrets) -> Connection:
    cid = uuid.uuid4()
    dek = await get_or_create_tenant_dek(db, tenant_id)
    ct, nonce = encrypt_secret(
        dek, secrets, tenant_id=tenant_id, connection_id=cid, provider_name=provider
    )
    conn = Connection(
        id=cid, tenant_id=tenant_id, name=name, provider_kind=kind,
        provider_name=provider, ciphertext=ct, nonce=nonce,
    )
    db.add(conn)
    await db.flush()
    return conn


async def cmd_create_tenant(args) -> None:
    async with session_scope() as db:
        tenant, key = await _create_tenant_and_key(db, args.name, args.slug)
    print(f"Tenant: {tenant.id}  ({tenant.slug})")
    print(f"API key (shown once): {key}")


async def cmd_seed_dev(args) -> None:
    slug = args.slug or f"dev-{uuid.uuid4().hex[:6]}"
    async with session_scope() as db:
        tenant, key = await _create_tenant_and_key(db, args.name, slug)

        stt = await _add_connection(
            db, tenant.id, "dev-deepgram", "stt", "deepgram",
            {"api_key": os.environ["DEEPGRAM_API_KEY"]},
        )
        cartesia_secrets = {"api_key": os.environ["CARTESIA_API_KEY"]}
        if args.voice_id:
            # The Cartesia voice id lives in the connection credential, not env
            # or a hardcoded default. Pass --voice-id to seed it.
            cartesia_secrets["voice_id"] = args.voice_id
        tts = await _add_connection(
            db, tenant.id, "dev-cartesia", "tts", "cartesia", cartesia_secrets,
        )
        llm_provider = os.getenv("VOICE_LLM_PROVIDER", "groq")
        llm_key_env = {"groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY",
                       "openrouter": "OPENROUTER_API_KEY", "openai": "OPENAI_API_KEY"}[llm_provider]
        llm = await _add_connection(
            db, tenant.id, f"dev-{llm_provider}", "llm", llm_provider,
            {"api_key": os.environ[llm_key_env]},
        )
        tele_id = None
        if os.getenv("PLIVO_AUTH_ID") and os.getenv("PLIVO_AUTH_TOKEN"):
            tele = await _add_connection(
                db, tenant.id, "dev-plivo", "telephony", "plivo",
                {"auth_id": os.environ["PLIVO_AUTH_ID"],
                 "auth_token": os.environ["PLIVO_AUTH_TOKEN"],
                 "from_number": os.getenv("PLIVO_FROM_NUMBER", "")},
            )
            tele_id = tele.id

        agent = Agent(
            tenant_id=tenant.id, name="Alex", company="Acme",
            instructions="You are a friendly voice assistant. Keep replies short and conversational.",
            first_message="Hi! I'm here to help. What can I do for you?",
            stt_connection_id=stt.id, tts_connection_id=tts.id, llm_connection_id=llm.id,
            telephony_connection_id=tele_id,
            provider_settings={
                "stt": {"model": os.getenv("VOICE_STT_MODEL", "nova-3")},
                # voice_id is not set here — it lives in the Cartesia connection
                # credential (see cartesia_secrets above), never on the agent.
                "tts": {
                    "model": os.getenv("VOICE_TTS_MODEL", "sonic-3"),
                    "emotion": os.getenv("VOICE_TTS_EMOTION", "positive and warm"),
                    "speed": float(os.getenv("VOICE_TTS_SPEED", "1.0")),
                },
                "llm": {"model": os.getenv("VOICE_LLM_MODEL", "llama-3.1-8b-instant")},
                "language": "en",
            },
        )
        db.add(agent)
        await db.flush()
        agent_id = agent.id
        tenant_id = tenant.id

    print("Seeded dev tenant + connections + agent.")
    print(f"  Tenant:  {tenant_id}  ({slug})")
    print(f"  Agent:   {agent_id}")
    print(f"  API key (shown once): {key}")
    print(f"\nFor the playground UI, add to .env:  DEV_AGENT_ID={agent_id}")
    if not args.voice_id:
        print(
            "\nNote: no --voice-id given, so the Cartesia connection has no voice_id. "
            "Set one on the connection (PATCH /v1/connections/<id> secrets) before "
            "calls will produce audio."
        )


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.admin")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ct = sub.add_parser("create-tenant", help="create a tenant + API key")
    p_ct.add_argument("--name", required=True)
    p_ct.add_argument("--slug", required=True)
    p_ct.set_defaults(func=cmd_create_tenant)

    p_sd = sub.add_parser("seed-dev", help="tenant + connections (from env) + demo agent")
    p_sd.add_argument("--name", default="Dev Tenant")
    p_sd.add_argument("--slug", default=None)
    p_sd.add_argument(
        "--voice-id", dest="voice_id", default=None,
        help="Cartesia voice id, stored in the Cartesia connection credential",
    )
    p_sd.set_defaults(func=cmd_seed_dev)

    args = parser.parse_args()
    asyncio.run(args.func(args))


if __name__ == "__main__":
    main()
