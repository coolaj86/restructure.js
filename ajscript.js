"use strict";

// do something like `throw new Error('break');` to stop
Promise._forEach = async function (arr, fn) {
    await arr.reduce(async function (promise, el, i) {
        await promise;
        await fn(el, i, arr);
    }, Promise.resolve());
};

Promise._parallel = async function (limit, arr, fn) {
    let index = 0;
    let actives = [];
    let results = [];

    function launch() {
        let _index = index;
        let p = fn(arr[_index], _index, arr);

        // some tasks may be synchronous
        // so we must push before removing
        actives.push(p);

        p.then(function _resolve(result) {
            let i = actives.indexOf(p);
            actives.splice(i, 1);
            results[_index] = result;
        });

        index += 1;
    }

    // start tasks in parallel, up to limit
    for (; actives.length < limit; ) {
        launch();
    }

    // keep the task queue full
    for (; index < arr.length; ) {
        // wait for one task to complete
        await Promise.race(actives);
        // add one task again
        launch();
    }

    // wait for all remaining tasks
    await Promise.all(actives);

    return results;
};
