# Vamp

Real-time multiplayer game framework for Cloudflare Workers.

## Packages

- **@vamp/ecs**: Entity-Component-System runtime for game state management
- **@vamp/rot**: Roguelike toolkit (pathfinding, FOV, map generation)
- **@vamp/utils**: Tempo RPC, Bebop serialization, WebSocket channels
- **@vamp/worker**: Cloudflare Workers Durable Object integration

## Setup

Run `vp install` to install dependencies.

## Basic Example

See `examples/basic/` for a complete working example.

1. Define schemas in `schema/` using Bebop format
2. Define ECS systems using `@vamp/ecs`
3. Run the game worker via Cloudflare Workers

```bash
# Check setup
vp run ready

# Run tests
vp run test -r

# Build
vp run build -r

# Development
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
