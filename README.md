# Reprompty

A framework for orchestrating multiple AI agent windows and prompt engineering workflows on Windows 11.

<img width="888" height="690" alt="image" src="https://github.com/user-attachments/assets/b116639d-5c9d-439e-bd87-7635b5868a03" />

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

<img width="892" height="699" alt="image" src="https://github.com/user-attachments/assets/dc097d2c-e12f-4900-97c2-9ad3d6198674" />

<img width="887" height="691" alt="image" src="https://github.com/user-attachments/assets/d654d5d8-f5a6-4e87-a09e-bf40e23ec75c" />

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.
