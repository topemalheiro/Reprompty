# Reprompty

A framework for orchestrating multiple AI agent windows and prompt engineering workflows on Windows 11.

<img width="883" height="690" alt="Screenshot 2026-04-19 184915" src="https://github.com/user-attachments/assets/04783edf-18d3-4465-8c9b-f27ff8092668" />

## Overview

Reprompty enables you to:

- Spawn multiple VS Code windows with isolated chat sessions, and [Aperant-MCP](https://github.com/topemalheiro/Aperant-MCP) i.e.
- Create prompt templates with XML tags for structured prompting
- Automate batch task execution across multiple windows
- Trigger skills and workflows based on conditions
- Build agent teams that collaborate on complex tasks
- Link LLMs to pass information or to sync to prepare for a merge for example.

## Features

### Window Management

- Spawn duplicate VS Code windows pointing to the same directory
- Each window maintains independent chat history
- Organize windows automatically using scripts

### Prompt Engineering

- XML-tagged prompt templates
- Variable substitution and context injection
- Prompt chaining and composition

### Automation

- Trigger skills based on events
- Batch task creation and management
- Workflow orchestration for multi-agent teams

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

Reprompty is designed as a modular framework that can:

- Run as a VS Code extension
- Integrate with existing tools like Kilo Code
- Spawn and manage native Windows processes

<img width="884" height="691" alt="Screenshot 2026-04-19 185119" src="https://github.com/user-attachments/assets/7a2ba45c-1446-49bc-9f83-15281b712a68" />

<img width="887" height="696" alt="Screenshot 2026-04-19 184955" src="https://github.com/user-attachments/assets/f3700d5e-5253-4d8e-9ddb-b98f030b2453" />

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.
