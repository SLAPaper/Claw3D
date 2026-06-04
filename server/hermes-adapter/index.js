"use strict";

const { createConfig } = require("./config");
const { createUtils } = require("./utils");
const { createState } = require("./state");
const { createHermesApi } = require("./hermes-api");
const { createSkills } = require("./skills");
const { createOrchestration } = require("./orchestration");
const { createHandleMethod } = require("./methods");
const { createEvents, createStartAdapter } = require("./server");

function createRuntime() {
  const config = createConfig();
  const utils = createUtils(config);
  const state = createState(config, utils);
  const hermes = createHermesApi(config, utils);
  const events = createEvents();
  const skills = createSkills(config, state, utils);

  const ctx = {
    config,
    utils,
    state,
    hermes,
    events,
    skills,
    orchestration: null,
  };

  ctx.orchestration = createOrchestration(ctx);
  const handleMethod = createHandleMethod(ctx);
  const startAdapter = createStartAdapter(ctx, handleMethod);

  return {
    handleMethod,
    startAdapter,
    loadHistoryFromDisk: state.loadHistoryFromDisk,
  };
}

module.exports = {
  createRuntime,
};
