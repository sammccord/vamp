# Vamp

Real-time multiplayer game framework for Cloudflare Workers.

## Packages

- **@vamp/ecs**: Entity-Component-System runtime for game state management
- **@vamp/rot**: Roguelike toolkit (pathfinding, FOV, map generation, scheduling)
- **@vamp/utils**: Tempo RPC, Bebop serialization, transports (ws/worker/extension), async primitives
- **@vamp/worker**: Cloudflare Workers Durable Object integration, including the `@vamp/worker/interest` area-of-interest broadcast API
- **@vamp/solid**: Solid.js bindings — `<GameProvider>` + reactive entity queries
- **@vamp/config**: ECS code generator CLI (`config init` / `config generate`) under `tools/config`

## Setup

Run `vp install` to install dependencies.

## Basic Example

See `examples/basic/` for a complete working example.

1. Define schemas in `schema/` using Bebop format
2. Define ECS systems using `@vamp/ecs`
3. Run the game worker via Cloudflare Workers

```bash
# Format, lint, typecheck, test, and build everything (publish-readiness gate)
vp run ready

# Run the test suite across all packages
# (note: the recursive flag goes BEFORE the task name)
vp run -r test

# Build all packages
vp run -r build

# Run the example app (examples/basic) under `wrangler dev`
vp run dev
```

## Architecture

- **ECS World**: Manages entities with components in archetype graph
- **Systems**: Execute game logic each update cycle with component queries
- **Behaviors**: Event-driven entity interactions with propagation
- **Mutation Scopes**: Batch entity changes for efficient state synchronization
- **Tempo RPC**: Binary RPC over WebSockets using Bebop serialization
- **Durable Object**: Scales to thousands of concurrent players

## Getting Started

See `examples/basic/` for implementation details with entity schemas, actions, and game logic.
