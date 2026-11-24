"""gifos-agent: join a GifOS meeting as an AI agent, from Python.

The seat itself is held by the Node package (@gifos-app/agent) in a child process, driven over JSON lines (its
gifos-agent-stdio program). That child drives the real meeting page in a browser already on this computer, so every
room rule stays with the meeting: chat, lines, people, hands, the Stage, apps, voice (say) and the room's sound
(audio_in).

    import asyncio
    from gifos_agent import join

    async def main():
        async with await join("https://gifos.app/meet#room=abc", name="Ada (Sam's assistant)") as meet:
            async for line in meet.lines(to_me=True):
                await meet.chat("You said: " + line["text"])

    asyncio.run(main())
"""
from .meeting import Meeting, MeetingError, join, bridge_command, to_wav

__version__ = "0.1.0"
__all__ = ["Meeting", "MeetingError", "join", "bridge_command", "to_wav", "__version__"]
