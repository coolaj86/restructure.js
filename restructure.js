"use strict";

require("./ajscript.js");

let Fs = require("fs").promises;
let FsSync = require("fs");
let Path = require("path");

let Walk = require("@root/walk");

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let moduleMapPath = "./module-map.json";
let ModuleMap = { _cache: {}, _map: {} };
try {
    let text = FsSync.readFileSync(moduleMapPath, "utf8");
    ModuleMap._map = JSON.parse(text);
    Object.entries(function ([key, val]) {
        if (ModuleMap._cache[val]) {
            throw new Error(
                `duplicate entry for ${val}: ${key}, ${ModuleMap._cache[val]}`
            );
        }
        ModuleMap._cache[val] = key;
    });
} catch (e) {
    // ignore
}
ModuleMap.get = function (path) {
    return ModuleMap._map[path];
};
ModuleMap.reverse = function (name) {
    return ModuleMap._cache[name];
};
ModuleMap.save = async function (abspath, name) {
    ModuleMap._map[abspath] = name;
    await Fs.writeFile(
        moduleMapPath,
        JSON.stringify(ModuleMap._map, null, 2),
        "utf8"
    );
};

async function main() {
    let rootname;
    let args = process.argv.slice(2);
    let pathsOnly = removeFlag(args, ["--paths-only"]);
    let dirs = args;
    if (!dirs.length) {
        dirs.push("./");
    }

    let oldVars = {};

    await Promise._forEach(dirs, walkDir);

    async function walkDir(dir) {
        rootname = Path.resolve(dir);
        await Walk.walk(dir, walkFunc);
    }

    async function walkFunc(err, pathname, dirent) {
        if (err) {
            throw err;
        }

        let shortname = pathname.slice(rootname.length + 1);

        if (dirent.isDirectory()) {
            if (dirent.name.startsWith(".") || "node_modules" === dirent.name) {
                return false;
            }
            return;
        }

        if (!dirent.name.toLowerCase().endsWith(".js")) {
            return;
        }

        let dirname = Path.dirname(shortname);
        let script = await Fs.readFile(pathname, "utf8");
        let kb = (script.length / 1024).toFixed(2).padStart(5, " ");

        let results = await parse(script, shortname, rootname, { pathsOnly });
        if (
            Object.keys(results.warnings).length ||
            Object.keys(results.multiImporters).length
        ) {
            console.info(`${dirname}/${dirent.name} (${kb} KB)`);
        }
        if (Object.keys(results.warnings).length) {
            Object.keys(results.warnings).forEach(function (pathname) {
                results.warnings[pathname].forEach(function (warning) {
                    console.warn(warning);
                });
            });
        }
        results.changes.forEach(function (c) {
            script = script.replace(
                new RegExp(escapeRegExp(c.pattern), "g"),
                c.replacement
            );
            console.info("[change]", c.comment);
        });
        await Fs.writeFile(pathname, script, "utf8");

        if (!Object.keys(results.multiImporters).length) {
            return;
        }
        //console.log(`${shortname}:`);
        let abspaths = Object.keys(results.multiImporters);
        await Promise._forEach(abspaths, async function (projpath) {
            //console.log("Projpath", projpath);
            let _projpath = projpath.replace("/index.js", "/");
            let restruct = results.multiImporters[projpath];
            let newName = ModuleMap.get(_projpath);
            let assignmentList = JSON.stringify(restruct.assignments);
            if (!newName) {
                projpath = projpath.replace("/index.js", "");
                let basename = Path.basename(projpath);
                let category = Path.basename(Path.dirname(projpath));
                let suggestion =
                    basename[0].toUpperCase() +
                    basename
                        .slice(1)
                        .replace(/(\.js|\/)$/, "")
                        .replace(/(-|_)\w/g, function (ch) {
                            return ch.slice(1).toUpperCase();
                        });
                if ("util" === category) {
                    suggestion += "Util";
                } else if ("models" === category) {
                    suggestion += "Model";
                }
                newName = await ask(
                    `\nWhat should we name ${restruct.require}?\n` +
                        `(prefix for ${assignmentList})\n` +
                        `[${suggestion}] > `
                );
                if (!newName) {
                    newName = suggestion;
                }
                await ModuleMap.save(_projpath, newName);
            }

            let newNameRe = new RegExp(`\\b${newName}\\b`);
            if (newNameRe.test(script)) {
                throw new Error(`Found ${newName} already in ${shortname}`);
            }
            // ex 'let { a, b, c } = require('foo')'
            // => 'let Foo = require('Foo');
            script = script.replace(
                new RegExp(escapeRegExp(restruct.input), "g"),
                newName
            );
            restruct.assignments.forEach(function (assignment) {
                // 'Foo'
                // ' Foo'
                // '(Foo)'
                // '[Foo]'
                // X '.Foo'
                let oldVar = new RegExp(
                    `(^|\\s|\\(|\\[)(${assignment})\\b`,
                    "g"
                );
                script = script.replace(oldVar, function ($0, $1, $2) {
                    return `${$1}${newName}.${$2}`;
                });
                oldVars[assignment] = undefined;
            });

            // TODO check if newName is already used in the code by something else
            // singleImporters[newName]
        });
        await Fs.writeFile(pathname, script, `utf8`);

        //console.log(results.singleImporters);
        //console.log(results.multiImporters);
        console.log();
    }
    console.log("Old Vars:");
    console.log(
        Object.keys(oldVars)
            .sort(function (a, b) {
                return a.length - b.length;
            })
            .map(function (word) {
                if (word === word.toLowerCase()) {
                    word += " <==========";
                }
                return word;
            })
            .join(`\n`)
    );
    console.log();
}

/**
 * @param {Array<String>} arr
 * @param {Array<String>} aliases
 * @returns {String?}
 */
function removeFlag(arr, aliases) {
    /** @type {String?} */
    let arg = null;
    aliases.forEach(function (item) {
        let index = arr.indexOf(item);
        if (-1 === index) {
            return null;
        }

        if (arg) {
            throw Error(`duplicate flag ${item}`);
        }

        arg = arr.splice(index, 1)[0];
    });

    return arg;
}

async function parse(script, shortname, rootname, opts) {
    /*
     * Example:
     *   let script = `
     *     let {
     *        a,
     *        b,
     *        c
     *     } = require('./foo/bar/baz.js');
     *   `;
     * // [ "a", "b", "'./foo/bar/baz.js'" ]
     */

    let reqRe =
        /(var|let|const)\s+(\w+|{[^}]+})\s+= require\((['"`]([^)]+)['"`])\)/gm;
    let assignmentRe = /{([^}]+)}/m;
    let warnings = {};
    let singleImporters = {};
    let multiImporters = {};
    let changes = [];

    for (let m = reqRe.exec(script); m; m = reqRe.exec(script)) {
        let keyword = m[1];
        let rawAssignment = m[2];
        let assignment = rawAssignment.trim().replace(/\s+/g, " ");
        let rawPathname = m[3];
        let pathname = m[4];
        //console.log("source:", keyword, assignment, rawPathname);

        let change = await addCanonicalNameChanges(
            rootname,
            shortname,
            rawPathname,
            pathname,
            warnings
        );
        if (change) {
            changes.push(change);
        }

        let _pathname = pathname;
        let abspath = _pathname; // assuming `node_modules/${pathname}`
        let looksLikeDir = false;
        if (_pathname.endsWith("/")) {
            looksLikeDir = true;
        }
        if (_pathname.startsWith("./")) {
            let dirname = Path.dirname(shortname);
            _pathname = Path.join(dirname, _pathname);
            _pathname = Path.resolve(rootname, _pathname);
            _pathname = _pathname.slice(rootname.length + 1);
            abspath = `./${_pathname}`;
            if (looksLikeDir) {
                abspath = `${abspath}/`;
            }
        }
        if (_pathname.startsWith("$")) {
            _pathname = _pathname.slice(2);
            abspath = `./${_pathname}`;
        }
        /*
        if (abspath.endsWith("/")) {
            abspath += "index.js";
        }
        */

        let destructured = assignment.match(assignmentRe);
        let assignments;

        if (destructured) {
            if (opts?.pathsOnly) {
                continue;
            }

            // '{ foo, bar, }' => [ "foo", "bar" ]
            assignments = destructured[1]
                .replace(/,/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .split(" ");
            if (multiImporters[abspath]) {
                if (!warnings[abspath]) {
                    warnings[abspath] = [];
                }
                warnings[abspath].push(
                    `confusing redeclaration: ${keyword} { ${assignments} } = ${pathname}`
                );
            }
            multiImporters[abspath] = {
                require: rawPathname,
                input: rawAssignment,
                assignments,
            };
            console.log(multiImporters[abspath]);
            continue;
        }

        // single import style
        let otherModule = ModuleMap.reverse(assignment);
        if (otherModule) {
            throw new Error(
                `duplicate import name: ${assignment}: ${otherModule}`
            );
        }

        if (singleImporters[assignment]) {
            if (abspath !== singleImporters[assignment]) {
                if (!warnings[abspath]) {
                    warnings[abspath] = [];
                }
                warnings[abspath].push(
                    `confusing redeclaration: ${keyword} ${assignment} = ${pathname}`
                );
                continue;
            }
        }

        singleImporters[assignment] = abspath;
        //assignments = [assignment];
    }

    return {
        changes,
        warnings,
        singleImporters,
        multiImporters,
    };
}

async function addCanonicalNameChanges(
    rootname,
    shortname,
    rawPathname,
    pathname,
    warnings
) {
    let abspath;
    let isLocal = false;
    let looksLikeDir = false;
    if (pathname.endsWith("/")) {
        looksLikeDir = true;
    }
    if (pathname.startsWith("./")) {
        let dirname = Path.dirname(shortname);
        pathname = Path.join(dirname, pathname);
        abspath = Path.resolve(rootname, pathname);
        pathname = abspath.slice(rootname.length + 1);
        pathname = `./${pathname}`;
        isLocal = true;
    }
    if (pathname.startsWith("$")) {
        pathname = pathname.slice(2);
        pathname = `./${pathname}`;
        abspath = Path.resolve(rootname, pathname);
        isLocal = true;
    }
    /*
    if (looksLikeDir && !pathname.endsWith("/")) {
        pathname = `${pathname}/`;
    }
    */
    if (
        !isLocal ||
        looksLikeDir ||
        pathname.endsWith(".js") ||
        pathname.endsWith(".json")
    ) {
        return null;
    }

    let change;
    let quote = rawPathname[0];
    if (!(await Fs.access(abspath).catch(Object))) {
        // The directory '/Users/me/Projects/x/whatever/' exists
        let newPathname = rawPathname.slice(0, -1) + `/${quote}`;
        change = {
            pattern: rawPathname,
            replacement: newPathname,
            comment: `add missing trailing '/' to directory require: '${rawPathname}'`,
        };
    } else if (!(await Fs.access(`${abspath}.js`).catch(Object))) {
        // The file '/Users/me/Projects/x/whatever.js' exists
        let quote = rawPathname[0];
        let newPathname = rawPathname.slice(0, -1) + `.js${quote}`;
        if (!change) {
            change = {
                pattern: rawPathname,
                replacement: newPathname,
                comment: `add missing trailing '.js' to file require: '${rawPathname}'`,
            };
        } else {
            change = null;
            if (!warnings[pathname]) {
                warnings[pathname] = [];
            }
            warnings[pathname].push(
                `ambiguous require: ${pathname}: is both file and directory`
            );
        }
    } else {
        if (!warnings[pathname]) {
            warnings[pathname] = [];
        }
        warnings[pathname].push(
            `missing require: ${pathname}: neither file nor directory`
        );
    }

    return change;
}

// https://github.com/google/zx/blob/51fb6d5d710fcd0bfcc7bc905066ac0fa042467c/index.mjs#L143
async function ask(query, options) {
    let Readline = require("readline");
    let completer;
    if (options?.choices) {
        completer = function completer(line) {
            let completions = options.choices;
            let hits = completions.filter(function (c) {
                return c.startsWith(line);
            });
            if (!hits.length) {
                hits = completions;
            }
            return [hits, line];
        };
    }
    let rl = Readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer,
    });
    let answer = await new Promise(function (resolve) {
        return rl.question(query ?? "", resolve);
    });
    rl.close();
    return answer;
}

main().catch(function (err) {
    console.error("Fail:");
    console.error(err.stack || err);
    process.exit(1);
});
