"use strict";

const { createConfig } = require("./config");
const { createUtils } = require("./utils");
const { createState } = require("./state");
const { createWorkspaceFiles } = require("./workspace-files");
const { createHermesApi } = require("./hermes-api");
const { createSkills } = require("./skills");
const { createOrchestration } = require("./orchestration");
const { createScheduler } = require("./scheduler");
const { createHandleMethod } = require("./methods");
const { createEvents, createStartAdapter } = require("./server");

function createRuntime() {
  const config = createConfig();
  const utils = createUtils(config);
  const state = createState(config, utils);
  const workspaceFiles = createWorkspaceFiles(config, utils);
  const hermes = createHermesApi(config, utils);
  const events = createEvents();
  const skills = createSkills(config, state, utils, workspaceFiles);

  const ctx = {
    config,
    utils,
    state,
    workspaceFiles,
    hermes,
    events,
    skills,
    orchestration: null,
    scheduler: null,
  };

  ctx.orchestration = createOrchestration(ctx);
  ctx.scheduler = createScheduler(ctx);
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
