"use strict";

const { createRuntime } = require("./hermes-adapter");

const adapter = createRuntime();

if (require.main === module) {
  adapter.loadHistoryFromDisk();
  adapter.startAdapter();
}

module.exports = {
  handleMethod: adapter.handleMethod,
  startAdapter: adapter.startAdapter,
};
