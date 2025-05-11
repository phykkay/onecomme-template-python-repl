const LIMIT = 30
const app = Vue.createApp({
  setup() {
    document.body.removeAttribute('hidden')
  },
  data () {
    return {
      comments: []
    }
  },
  methods: {
    getClassName(comment) {
      if (comment.commentIndex % 2 === 0) {
        return 'comment even'
      }
      return 'comment odd'
    },
    getStyle(comment) {
      return OneSDK.getCommentStyle(comment)
    }
  },
  mounted () {
    commentIndex = 0
    OneSDK.setup({
      mode: 'diff',
      commentLimit: LIMIT,
      disabledDelay: true
    })

    OneSDK.subscribe({
      action: 'comments',
      callback: (comments) => {
        comments.forEach(function(comment, index) {
          exec_from_comment(comment);
        });
      }
    })
    OneSDK.connect()
  },
})
OneSDK.ready().then(() => {
  app.mount("#container");
})

// Insert comment as code
function exec_from_comment(comment) {
  // Convert &gt; to >, etc.
  let unescaped_comment = $('<div/>').html(comment.data.comment).text();
  // Execute command with user displayname as comment
  let cmdline = `${unescaped_comment}  # ${comment.data.displayName}`
  // Execute with typing animation
  term.exec(cmdline, {typing: true, delay: 10});
}


// Pyodide console
// Ref: https://pyodide.org/en/stable/console.html
function sleep(s) {
  return new Promise((resolve) => setTimeout(resolve, s));
}

async function main() {
  let indexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";
  const urlParams = new URLSearchParams(window.location.search);
  const buildParam = urlParams.get("build");
  if (buildParam) {
    if (["full", "debug", "pyc"].includes(buildParam)) {
      indexURL = indexURL.replace(
        "/full/",
        "/" + urlParams.get("build") + "/",
      );
    } else {
      console.warn(
        'Invalid URL parameter: build="' +
          buildParam +
          '". Using default "full".',
      );
    }
  }
  const { loadPyodide } = await import(indexURL + "pyodide.mjs");
  // to facilitate debugging
  globalThis.loadPyodide = loadPyodide;

  let term;
  globalThis.pyodide = await loadPyodide({
    stdin: () => {
      let result = prompt();
      echo(result);
      return result;
    },
  });
  let { repr_shorten, BANNER, PyodideConsole } =
    pyodide.pyimport("pyodide.console");
  BANNER =
    `Welcome to the Pyodide ${pyodide.version} terminal emulator 🐍\n` +
    BANNER;
  const pyconsole = PyodideConsole(pyodide.globals);

  const namespace = pyodide.globals.get("dict")();
  const await_fut = pyodide.runPython(
    `
    import builtins
    from pyodide.ffi import to_js

    async def await_fut(fut):
        res = await fut
        if res is not None:
            builtins._ = res
        return to_js([res], depth=1)

    await_fut
    `,
    { globals: namespace },
  );
  namespace.destroy();

  const echo = (msg, ...opts) =>
    term.echo(
      msg
        .replaceAll("]]", "&rsqb;&rsqb;")
        .replaceAll("[[", "&lsqb;&lsqb;"),
      ...opts,
    );

  const ps1 = ">>> ";
  const ps2 = "... ";

  async function lock() {
    let resolve;
    const ready = term.ready;
    term.ready = new Promise((res) => (resolve = res));
    await ready;
    return resolve;
  }

  async function interpreter(command) {
    const unlock = await lock();
    term.pause();
    // multiline should be split (useful when pasting)
    for (const c of command.split("\n")) {
      const escaped = c.replaceAll(/\u00a0/g, " ");
      const fut = pyconsole.push(escaped);
      term.set_prompt(fut.syntax_check === "incomplete" ? ps2 : ps1);
      switch (fut.syntax_check) {
        case "syntax-error":
          term.error(fut.formatted_error.trimEnd());
          continue;
        case "incomplete":
          continue;
        case "complete":
          break;
        default:
          throw new Error(`Unexpected type ${ty}`);
      }
      // In JavaScript, await automatically also awaits any results of
      // awaits, so if an async function returns a future, it will await
      // the inner future too. This is not what we want so we
      // temporarily put it into a list to protect it.
      const wrapped = await_fut(fut);
      // complete case, get result / error and print it.
      try {
        const [value] = await wrapped;
        if (value !== undefined) {
          echo(
            repr_shorten.callKwargs(value, {
              separator: "\n<long output truncated>\n",
            }),
          );
        }
        if (value instanceof pyodide.ffi.PyProxy) {
          value.destroy();
        }
      } catch (e) {
        if (e.constructor.name === "PythonError") {
          const message = fut.formatted_error || e.message;
          term.error(message.trimEnd());
        } else {
          throw e;
        }
      } finally {
        fut.destroy();
        wrapped.destroy();
      }
    }
    term.resume();
    await sleep(10);
    unlock();
  }

  term = $("#terminal-container").terminal(interpreter, {
    greetings: BANNER,
    prompt: ps1,
    completionEscape: false,
    completion: function (command, callback) {
      callback(pyconsole.complete(command).toJs()[0]);
    },
    keymap: {
      "CTRL+C": async function (event, original) {
        pyconsole.buffer.clear();
        term.enter();
        echo("KeyboardInterrupt");
        term.set_command("");
        term.set_prompt(ps1);
      },
      TAB: (event, original) => {
        const command = term.before_cursor();
        // Disable completion for whitespaces.
        if (command.trim() === "") {
          term.insert("\t");
          return false;
        }
        return original(event);
      },
    },
  });
  window.term = term;
  pyconsole.stdout_callback = (s) => echo(s, { newline: false });
  pyconsole.stderr_callback = (s) => {
    term.error(s.trimEnd());
  };
  term.ready = Promise.resolve();
  pyodide._api.on_fatal = async (e) => {
    if (e.name === "Exit") {
      term.error(e);
      term.error("Pyodide exited and can no longer be used.");
    } else {
      term.error(
        "Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.",
      );
      term.error("The cause of the fatal error was:");
      term.error(e);
      term.error("Look in the browser console for more details.");
    }
    await term.ready;
    term.pause();
    await sleep(15);
    term.pause();
  };

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.has("noblink")) {
    $(".cmd-cursor").addClass("noblink");
  }

  let idbkvPromise;
  async function getIDBKV() {
    if (!idbkvPromise) {
      idbkvPromise = await import(
        "https://unpkg.com/idb-keyval@5.0.2/dist/esm/index.js"
      );
    }
    return idbkvPromise;
  }

  async function mountDirectory(pyodideDirectory, directoryKey) {
    if (pyodide.FS.analyzePath(pyodideDirectory).exists) {
      return;
    }
    const { get, set } = await getIDBKV();
    const opts = {
      id: "mountdirid",
      mode: "readwrite",
    };
    let directoryHandle = await get(directoryKey);
    if (!directoryHandle) {
      directoryHandle = await showDirectoryPicker(opts);
      await set(directoryKey, directoryHandle);
    }
    const permissionStatus =
      await directoryHandle.requestPermission(opts);
    if (permissionStatus !== "granted") {
      throw new Error("readwrite access to directory not granted");
    }
    await pyodide.mountNativeFS(pyodideDirectory, directoryHandle);
  }
  globalThis.mountDirectory = mountDirectory;
}
window.console_ready = main();
