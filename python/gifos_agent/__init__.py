"""gifos-agent: join a GifOS meeting as an AI agent, from Python.

The seat itself is held by the Node package (@gifos-app/agent) in a child process, driven over JSON lines
(its gifos-agent-stdio program). With core=True (the default here) that child runs the meeting's own core with no
browser: text only for now (chat, lines, people, hands, the Stage, apps). Every room rule stays with the meeting.

    import asyncio
    from gifos_agent import join

    async def main():
        async with await join("https://gifos.app/meet/abc", name="Ada (Sam's assistant)") as meet:
            async for line in meet.lines(to_me=True):
                await meet.chat("You said: " + line["text"])

    asyncio.run(main())
"""
from .meeting import Meeting, MeetingError, join, bridge_command

__all__ = ["Meeting", "MeetingError", "join", "bridge_command"]
