//
//  Created by Mingliang Chen on 18/3/16.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//
const Logger = require('./node_core_logger');

const NodeCoreUtils = require('./node_core_utils');
const NodeRelaySession = require('./node_relay_session');
const context = require('./node_core_ctx');
const { getFFmpegVersion, getFFmpegUrl } = require('./node_core_utils');
const fs = require('fs');
const querystring = require('querystring');
const _ = require('lodash');

class NodeRelayServer {
  constructor(config) {
    this.config = config;
    this.staticCycle = null;
    this.staticSessions = new Map();
    this.dynamicSessions = new Map();
  }

  async run() {
    try {
      fs.accessSync(this.config.relay.ffmpeg, fs.constants.X_OK);
    } catch (error) {
      Logger.error(`Node Media Relay Server startup failed. ffmpeg:${this.config.relay.ffmpeg} cannot be executed.`);
      return;
    }

    let version = await getFFmpegVersion(this.config.relay.ffmpeg);
    if (version === '' || parseInt(version.split('.')[0]) < 4) {
      Logger.error('Node Media Relay Server startup failed. ffmpeg requires version 4.0.0 above');
      Logger.error('Download the latest ffmpeg static program:', getFFmpegUrl());
      return;
    }
    this.relayPullRef = this.onRelayPull.bind(this);
    this.relayPushRef = this.onRelayPush.bind(this);
    this.prePlayRef = this.onPrePlay.bind(this);
    this.donePlayRef = this.onDonePlay.bind(this);
    this.postPublishRef = this.onPostPublish.bind(this);
    this.donePublishRef = this.onDonePublish.bind(this);

    context.nodeEvent.on('relayPull', this.relayPullRef);
    context.nodeEvent.on('relayPush', this.relayPushRef);
    context.nodeEvent.on('prePlay', this.prePlayRef);
    context.nodeEvent.on('donePlay', this.donePlayRef);
    context.nodeEvent.on('postPublish', this.postPublishRef);
    context.nodeEvent.on('donePublish', this.donePublishRef);
    this.staticCycle = setInterval(this.onStatic.bind(this), 1000);
    Logger.log('Node Media Relay Server started');
  }

  onStatic() {
    if (!this.config.relay.tasks) {
      return;
    }
    let i = this.config.relay.tasks.length;
    while (i--) {
      if (this.staticSessions.has(i)) {
        continue;
      }

      let conf = this.config.relay.tasks[i];
      let isStatic = conf.mode === 'static';
      if (isStatic) {
        conf.name = conf.name ? conf.name : NodeCoreUtils.genRandomName();
        conf.ffmpeg = this.config.relay.ffmpeg;
        conf.inPath = conf.edge;
        conf.ouPath = `rtmp://127.0.0.1:${this.config.rtmp.port}/${conf.app}/${conf.name}`;
        let session = new NodeRelaySession(conf);
        session.id = i;
        session.streamPath = `/${conf.app}/${conf.name}`;
        session.on('end', (id) => {
          this.staticSessions.delete(id);
        });
        this.staticSessions.set(i, session);
        session.run();
        Logger.log('[relay static pull] start', i, conf.inPath, 'to', conf.ouPath);
      }
    }
  }

  //从远端拉推到本地
  onRelayPull(url, app, name) {
    let conf = {};
    conf.app = app;
    conf.name = name;
    conf.ffmpeg = this.config.relay.ffmpeg;
    conf.inPath = url;
    conf.ouPath = `rtmp://127.0.0.1:${this.config.rtmp.port}/${app}/${name}`;
    let session = new NodeRelaySession(conf);
    const id = session.id;
    context.sessions.set(id, session);
    session.on('end', (id) => {
      this.dynamicSessions.delete(id);
    });
    this.dynamicSessions.set(id, session);
    session.run();
    Logger.log('[relay dynamic pull] start id=' + id, conf.inPath, 'to', conf.ouPath);
    return id;
  }

  //从本地拉推到远端
  onRelayPush(url, app, name) {
    let conf = {};
    conf.app = app;
    conf.name = name;
    conf.ffmpeg = this.config.relay.ffmpeg;
    conf.inPath = `rtmp://127.0.0.1:${this.config.rtmp.port}/${app}/${name}`;
    conf.ouPath = url;
    let session = new NodeRelaySession(conf);
    const id = session.id;
    context.sessions.set(id, session);
    session.on('end', (id) => {
      this.dynamicSessions.delete(id);
    });
    this.dynamicSessions.set(id, session);
    session.run();
    Logger.log('[relay dynamic push] start id=' + id, conf.inPath, 'to', conf.ouPath);
  }

  onPrePlay(id, streamPath, args) {
    if (!this.config.relay.tasks) {
      return;
    }
    let regRes = /\/(.*)\/(.*)/gi.exec(streamPath);
    let [app, stream] = _.slice(regRes, 1);
    let i = this.config.relay.tasks.length;
    while (i--) {
      let conf = this.config.relay.tasks[i];
      let isPull = conf.mode === 'pull';
      if (isPull && app === conf.app && !context.publishers.has(streamPath)) {
        let hasApp = conf.edge.match(/rtmp:\/\/([^\/]+)\/([^\/]+)/);
        conf.ffmpeg = this.config.relay.ffmpeg;
        conf.inPath = hasApp ? `${conf.edge}/${stream}` : `${conf.edge}${streamPath}`;
        conf.ouPath = `rtmp://127.0.0.1:${this.config.rtmp.port}${streamPath}`;
        if(Object.keys(args).length > 0) {
          conf.inPath += '?';
          conf.inPath += querystring.encode(args);
        }
        let session = new NodeRelaySession(conf);
        session.id = id;
        session.on('end', (id) => {
          this.dynamicSessions.delete(id);
        });
        this.dynamicSessions.set(id, session);
        session.run();
        Logger.log('[relay dynamic pull] start id=' + id, conf.inPath, 'to', conf.ouPath);
      }
    }
  }

  onDonePlay(id, streamPath, args) {
    let session = this.dynamicSessions.get(id);
    let publisher = context.sessions.get(context.publishers.get(streamPath));
    if (session && publisher.players.size == 0) {
      session.end();
    }
  }

  onPostPublish(id, streamPath, args) {
    if (!this.config.relay.tasks) {
      return;
    }
    let regRes = /\/(.*)\/(.*)/gi.exec(streamPath);
    let [app, stream] = _.slice(regRes, 1);
    let i = this.config.relay.tasks.length;
    while (i--) {
      let conf = this.config.relay.tasks[i];
      let isPush = conf.mode === 'push';
      if (isPush && app === conf.app) {
        let hasApp = conf.edge.match(/rtmp:\/\/([^\/]+)\/([^\/]+)/);
        conf.ffmpeg = this.config.relay.ffmpeg;
        conf.inPath = `rtmp://127.0.0.1:${this.config.rtmp.port}${streamPath}`;
        conf.ouPath = conf.appendName === false ? conf.edge : (hasApp ? `${conf.edge}/${stream}` : `${conf.edge}${streamPath}`);
        if(Object.keys(args).length > 0) {
          conf.ouPath += '?';
          conf.ouPath += querystring.encode(args);
        }
        let session = new NodeRelaySession(conf);
        session.id = id;
        session.on('end', (id) => {
          this.dynamicSessions.delete(id);
        });
        this.dynamicSessions.set(id, session);
        session.run();
        Logger.log('[relay dynamic push] start id=' + id, conf.inPath, 'to', conf.ouPath);
      }
    }

  }

  onDonePublish(id, streamPath, args) {
    let session = this.dynamicSessions.get(id);
    if (session) {
      session.end();
    }

    for (session of this.staticSessions.values()) {
      if (session.streamPath === streamPath) {
        session.end();
      }
    }
  }

  stop() {
    context.nodeEvent.removeListener('relayPull', this.relayPullRef);
    context.nodeEvent.removeListener('relayPush', this.relayPushRef);
    context.nodeEvent.removeListener('prePlay', this.prePlayRef);
    context.nodeEvent.removeListener('donePlay', this.donePlayRef);
    context.nodeEvent.removeListener('postPublish', this.postPublishRef);
    context.nodeEvent.removeListener('donePublish', this.donePublishRef);
    clearInterval(this.staticCycle);
    for (let session of this.staticSessions.entries()) {
      let key = session[0],
          value = session[1];
      value.end()
    }
    for (let session of this.dynamicSessions.entries()) {
      let key = session[0],
          value = session[1];
      value.end()
    }
  }
}

module.exports = NodeRelayServer;
