# @vampgg/cli

ECS code generator CLI for @vampgg. Parses Bebop (`.bop`) schemas and emits the
TypeScript ECS components, factories, deltas, and mutation schemas used by a
`@vampgg` game.

## Usage

```bash
vamp init        # scaffold schema/ and a vamp.json config
vamp generate    # parse the .bop schemas and (re)generate TypeScript output
```

## Development

```bash
vp install     # install dependencies
vp test        # run the unit tests
vp run build   # build the CLI
```
