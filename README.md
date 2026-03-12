# Reprompty

A framework for orchestrating multiple AI agent windows and prompt engineering workflows on Windows 11.

## Overview

Reprompty enables you to:
- Spawn multiple VS Code windows with isolated chat sessions
- Create prompt templates with XML tags for structured prompting
- Automate batch task execution across multiple windows
- Trigger skills and workflows based on conditions
- Build agent teams that collaborate on complex tasks

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
git clone https://github.com/yourusername/reprompty.git

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

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.
