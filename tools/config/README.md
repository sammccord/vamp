# @vamp/config

ECS code generator CLI for @vamp. Parses Bebop (`.bop`) schemas and emits the
TypeScript ECS components, factories, deltas, and mutation schemas used by a
`@vamp` game.

## Usage

```bash
config init        # scaffold schema/ and a vamp.json config
config generate    # parse the .bop schemas and (re)generate TypeScript output
```

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the CLI
```
