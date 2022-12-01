# restructure.js

Restructure destructured requires (and rewrite require paths sanely)

## Example

Transforms this:

```js
let {
  doSomeStuff,
  doMoreThings,
} = require('./whatever-it-is');

// run doSomeStuff and then run doMoreThings
doSomeStuff().then(doMoreThings);
```

Into this:

```js
let WhateverItIs = require('./things/whatever-it-is.js');

// run WhateverItIs.doSomeStuff and then run WhateverItIs.doMoreThings
WhateverItIs.doSomeStuff().then(WhateverItIs.doMoreThings);
```

## Usage

```bash
git clone git@github.com:coolaj86/restructure.js.git ./de-destructure/
pushd ./de-destructure/
npm ci

node ./restructure.js ~/path/to/project/source/
```

## Why?

- Better package structure
  ```js
  Foo.create
  // (not createFoo)
  ```
- Easier to refactor
  ```bash
  sd 'Foo.createFoo' 'Foo.create' *.js */*.js
  ```
- Solves trivial circular dependency issues
  ```txt
  (node:29094) Warning: Accessing non-existent property 'Foo' of module exports inside circular dependency
  (Use `node --trace-warnings ...` to show where the warning was created)
  ```

## Caveats

It uses RegExp rather than a full parser, so it can make mistakes on things like this:

```js
let {
  create
} = require('./foo');

console.log('create another foo');
create();
```

```js
let Foo = require('./foo.js');

console.log('Foo.create another foo');
Foo.create();
```
