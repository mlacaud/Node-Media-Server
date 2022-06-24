//
//  Created by Mingliang Chen on 18/3/16.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//
const Logger = require('./node_core_logger');
const NodeCoreUtils = require('./node_core_utils');

const EventEmitter = require('events');
const { spawn } = require('child_process');

const RTSP_TRANSPORT = ['udp', 'tcp', 'udp_multicast', 'http'];

class NodeRelaySession extends EventEmitter {
  constructor(conf) {
    super();
    this.conf = conf;
    this.id = NodeCoreUtils.generateNewSessionID();
    this.TAG = 'relay';
  }

  run() {
    let format = this.conf.ouPath.startsWith('rtsp://') ? 'rtsp' : 'flv';
    let argv = ['-i', this.conf.inPath];
    if (this.conf.inPath[0] === '/' || this.conf.inPath[1] === ':') {
      argv.unshift('-1');
      argv.unshift('-stream_loop');
    }

    if (this.conf.inPath.startsWith('rtsp://') && this.conf.rtsp_transport) {
      if (RTSP_TRANSPORT.indexOf(this.conf.rtsp_transport) > -1) {
        argv.unshift(this.conf.rtsp_transport);
        argv.unshift('-rtsp_transport');
      }
    }

    if (this.conf.addMutedAudio) {
      argv.unshift('-f');
      argv.unshift('lavfi');
      argv.unshift('-i');
      argv.unshift('anullsrc=channel_layout=stereo:sample_rate=44100');
      argv.push('-c:v');
      argv.push('copy');
      argv.push('-c:a');
      argv.push('aac');
    } else {
      argv.push('-c');
      argv.push('copy');
    }

    argv.unshift('-re');
    argv.push('-f');
    argv.push(format);  
    argv.push(this.conf.ouPath)
    
    Logger.log('[relay task] id='+this.id,'cmd=ffmpeg', argv.join(' '));

    this.ffmpeg_exec = spawn(this.conf.ffmpeg, argv);
    this.ffmpeg_exec.on('error', (e) => {
      Logger.ffdebug(e);
    });

    this.ffmpeg_exec.stdout.on('data', (data) => {
      Logger.ffdebug(`FF输出：${data}`);
    });

    this.ffmpeg_exec.stderr.on('data', (data) => {
      Logger.ffdebug(`FF输出：${data}`);
    });

    this.ffmpeg_exec.on('close', (code) => {
      Logger.log('[relay end] id='+this.id,'code='+code);
      this.emit('end', this.id);
    });
  }

  end() {
    this.ffmpeg_exec.kill();
  }
}

module.exports = NodeRelaySession;
