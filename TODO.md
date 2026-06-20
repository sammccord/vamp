# TODO

- Modify the ./tools/config generator for the typescript codegen to include a `GameContext` type export near the bottom for the server environment context provided to RPC method implementations which will be `[ECS<RuntimeContext<UserSession, Context>, UpdateArguments, Actions, Tags, Entity, EntityDelta>, WebSocket]` as seen on line 520 of packages/worker/src/ecs.ts - this is for user convenience so RPC method implementations can import it like `const [ecs, ws] = ctx.getEnvironment<GameContext>()` and interact with foreign dependencies.
- Implement the RPC Service in the ./examples/basic application. This task will involve the following acceptance criteria:
  - implementing the `RpcService` bebop service in ./examples/basic/src/rpc.service.ts, registering it with the `TempoServiceRegistry` exported from ./examples/basic/src/bebop.ts with `@TempoServiceRegistry.register(BaseRpcService.serviceName)` - see /Users/ofnir/.openclaw/workspace/repos/vaporware/packages/workers/src/services/game/game.service.ts
    - For the `observe` method, the `createEventIterator` is available to assist in implementing the `AsyncGenerator` response in ./packages/utils/src/create-event-iterator.ts
  - pass the generated `TempoServiceRegistry` from `bebop.ts` to the `initialize` call in ./examples/basic/src/index.ts, effectively registering the RPC service implementation.
  - The actual game logic can be naive, we primarily care that entities can be created and synchronized with mutations streaming back to client.
- Verify the end-to-end functionality of the ./examples/basic application
  - The cloudflare worker app must compile and start in local dev mode
- Write a suite of integration tests in ./examples/basic that test against a locally running application
