# @loop.js/create

The scaffolder behind `npm create @loop.js` — writes a ready-to-run
[loop.js](https://github.com/loop-js/loop.js) project skeleton:

```
my-loop/
├── package.json     # depends on @loop.js/core (→ the `loop` bin)
├── loop.config.ts   # edit `goal`; tight limits ship live, other knobs are commented defaults
└── workspace/       # the work tree the agents build in
```

## Use

```sh
npm create @loop.js@latest my-loop
cd my-loop && npm install
loop run
```

`goal` is the only field you must edit. The runaway `limits` (3 Rounds, $1) ship live so a
first run can't surprise you, and every other knob — per-phase prompts, models, permissions —
appears as a commented line already carrying its engine default, so uncommenting is the
whole edit.

Full docs: <https://github.com/loop-js/loop.js> · Apache-2.0
