# Reprompty

Reprompty is an MCP Swiss Army knife for AI agent windows, tooling, desktop layouts, and cross-editor orchestration, with a focus on setting up layouts and work contexts visually, on Windows 11.
It helps you manage both the visual and technical side of agent workflows, prompt engineering, and lower-friction MCP handoffs.

I made a demo video: https://www.youtube.com/watch?v=myEoB4hP7Oo 

<img width="882" height="690" alt="Screenshot 2026-04-19 185635" src="https://github.com/user-attachments/assets/c10b5f99-d875-4d8f-b377-9c2fc1ddb7c5" />

## Overview

Reprompty enables you to:

- Shape the actual computer workflow, not just the prompt
- Spawn multiple VS Code windows with isolated chat sessions
- Organize windows, desktops, and layouts around the way you want to work
- Work cleanly alongside projects like [Aperant-MCP](https://github.com/topemalheiro/Aperant-MCP) without adding handoff friction
- Create prompt templates with XML tags for structured prompting
- Automate batch task execution across multiple windows
- Trigger skills and workflows based on conditions
- Build agent teams that collaborate on complex tasks
- Reduce friction when handing work off into Aperant and other MCP-driven flows
- Link LLMs to pass information or sync context to prepare for a merge, for example

## Features

### Window Management

- Spawn duplicate VS Code windows pointing to the same directory
- Each window maintains independent chat history
- Organize windows, desktops, and layouts automatically using scripts and MCP tools

### Prompt Engineering

- XML-tagged prompt templates
- Variable substitution and context injection
- Prompt chaining and composition

### Automation

- Trigger skills based on events
- Batch task creation and management
- Workflow orchestration for multi-agent teams
- Lower-friction handoffs into Aperant-style MCP workflows

### Agent Teams

- Coordinate multiple AI agents
- Parallel task execution
- Result aggregation and synthesis

## Getting Started

```bash
# Clone the repository
git clone https://github.com/topemalheiro/Reprompty.git

# Install dependencies
cd reprompty
npm install

# Run the framework
npm start
```

## Architecture

Reprompty is designed as a modular MCP toolkit that can:

- Run as a VS Code extension
- Integrate with existing tools like Kilo Code
- Spawn and manage native Windows processes
- Improve day-to-day UX at the computer-workflow level, not just inside one chat pane

<img width="884" height="691" alt="Screenshot 2026-04-19 185119" src="https://github.com/user-attachments/assets/7a2ba45c-1446-49bc-9f83-15281b712a68" />

<img width="887" height="696" alt="Screenshot 2026-04-19 184955" src="https://github.com/user-attachments/assets/f3700d5e-5253-4d8e-9ddb-b98f030b2453" />

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.
