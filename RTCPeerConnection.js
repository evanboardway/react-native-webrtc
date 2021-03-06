'use strict';

import EventTarget from 'event-target-shim';
import { NativeModules } from 'react-native';

import MediaStream from './MediaStream';
import MediaStreamEvent from './MediaStreamEvent';
import MediaStreamTrack from './MediaStreamTrack';
import MediaStreamTrackEvent from './MediaStreamTrackEvent';
import RTCDataChannel from './RTCDataChannel';
import RTCDataChannelEvent from './RTCDataChannelEvent';
import RTCSessionDescription from './RTCSessionDescription';
import RTCIceCandidate from './RTCIceCandidate';
import RTCIceCandidateEvent from './RTCIceCandidateEvent';
import RTCEvent from './RTCEvent';
import RTCRtpTransceiver from './RTCRtpTransceiver';
import * as RTCUtil from './RTCUtil';
import EventEmitter from './EventEmitter';

const { WebRTCModule } = NativeModules;

type RTCSignalingState =
  'stable' |
  'have-local-offer' |
  'have-remote-offer' |
  'have-local-pranswer' |
  'have-remote-pranswer' |
  'closed';

type RTCIceGatheringState =
  'new' |
  'gathering' |
  'complete';

type RTCPeerConnectionState =
  'new' |
  'connecting' |
  'connected' |
  'disconnected' |
  'failed' |
  'closed';

type RTCIceConnectionState =
  'new' |
  'checking' |
  'connected' |
  'completed' |
  'failed' |
  'disconnected' |
  'closed';

type RTCDataChannelInit = {
    ordered?: boolean;
    maxPacketLifeTime?: number;
    maxRetransmits?: number;
    protocol?: string;
    negotiated?: boolean;
    id?: number;
};

const PEER_CONNECTION_EVENTS = [
  'connectionstatechange',
  'icecandidate',
  'icecandidateerror',
  'iceconnectionstatechange',
  'icegatheringstatechange',
  'negotiationneeded',
  'signalingstatechange',
  'track',
  // Peer-to-peer Data API:
  'datachannel',
  // old:
  'addstream',
  'removestream',
];

let nextPeerConnectionId = 0;

export default class RTCPeerConnection extends EventTarget(PEER_CONNECTION_EVENTS) {
  localDescription: RTCSessionDescription;
  remoteDescription: RTCSessionDescription;

  signalingState: RTCSignalingState = 'stable';
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';

  onconnectionstatechange: ?Function;
  onicecandidate: ?Function;
  onicecandidateerror: ?Function;
  oniceconnectionstatechange: ?Function;
  onicegatheringstatechange: ?Function;
  onnegotiationneeded: ?Function;
  onsignalingstatechange: ?Function;

  ontrack: ?Function;

  onaddstream: ?Function;
  onremovestream: ?Function;

  _peerConnectionId: number;
  _localStreams: Array<MediaStream> = [];
  _remoteStreams: Array<MediaStream> = [];
  _subscriptions: Array<any>;
  _transceivers: Array<RTCRtpTransceiver> = [];

  constructor(configuration) {
    super();
    this._peerConnectionId = nextPeerConnectionId++;
    WebRTCModule.peerConnectionInit(configuration, this._peerConnectionId);
    this._registerEvents();
  }

  addStream(stream: MediaStream) {
      const index = this._localStreams.indexOf(stream);
      if (index !== -1) {
          return;
      }
      WebRTCModule.peerConnectionAddStream(stream._reactTag, this._peerConnectionId);
      this._localStreams.push(stream);
  }

  removeStream(stream: MediaStream) {
      const index = this._localStreams.indexOf(stream);
      if (index === -1) {
          return;
      }
      this._localStreams.splice(index, 1);
      WebRTCModule.peerConnectionRemoveStream(stream._reactTag, this._peerConnectionId);
  }

  addTransceiver(source: 'audio' |'video' | MediaStreamTrack, init) {
    return new Promise((resolve, reject) => {

      let src;
      if (source === 'audio') {
        src = { type: 'audio' };
      } else if (source === 'video') {
        src = { type: 'video' };
      } else {
        src = { trackId: source.id };
      }

      if(init.streams) {
        init.streamIds = init.streams.map(s => s.id)
        delete init.streams
      }

      console.log("init.streamIds: ", init.streamIds)
      console.log(`adding transciever for src: ${source.id} with opts: `, init)

      WebRTCModule.peerConnectionAddTransceiver(this._peerConnectionId, {...src, init: { ...init } }, (successful, data) => {
        if (successful) {
          this._mergeState(data.state);
          resolve(this._findTransceiver(data.id));
        } else {
          reject(data);
        }
      });
    });
  };

  createOffer(options) {
    return new Promise((resolve, reject) => {
      WebRTCModule.peerConnectionCreateOffer(
        this._peerConnectionId,
        RTCUtil.normalizeOfferAnswerOptions(options),
        (successful, data) => {
          if (successful) {
            this._mergeState(data.state);
            resolve(new RTCSessionDescription(data.session));
          } else {
            reject(data); // TODO: convert to NavigatorUserMediaError
          }
        });
    });
  }

  createAnswer(options = {}) {
    return new Promise((resolve, reject) => {
      WebRTCModule.peerConnectionCreateAnswer(
        this._peerConnectionId,
        RTCUtil.normalizeOfferAnswerOptions(options),
        (successful, data) => {
          if (successful) {
            this._mergeState(data.state);
            resolve(new RTCSessionDescription(data.session));
          } else {
            reject(data);
          }
        });
    });
  }

  setConfiguration(configuration) {
    WebRTCModule.peerConnectionSetConfiguration(configuration, this._peerConnectionId);
  }

  setLocalDescription(sessionDescription: RTCSessionDescription) {
    return new Promise((resolve, reject) => {
      WebRTCModule.peerConnectionSetLocalDescription(
        sessionDescription.toJSON ? sessionDescription.toJSON() : sessionDescription,
        this._peerConnectionId,
        (successful, data) => {
          if (successful) {
            this.localDescription = new RTCSessionDescription(data);
            this._mergeState(data.state);
            resolve();
          } else {
            reject(data);
          }
      });
    });
  }

  setRemoteDescription(sessionDescription: RTCSessionDescription) {
    return new Promise((resolve, reject) => {
      WebRTCModule.peerConnectionSetRemoteDescription(
        sessionDescription.toJSON ? sessionDescription.toJSON() : sessionDescription,
        this._peerConnectionId,
        (successful, data) => {
          if (successful) {
            this.remoteDescription = new RTCSessionDescription(data);
            this._mergeState(data.state);
            resolve();
          } else {
            reject(data);
          }
      });
    });
  }

  addIceCandidate(candidate) {
    if (!candidate || !candidate.candidate) {
      // TODO: support end-of-candidates, native crashes at this time.
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      WebRTCModule.peerConnectionAddICECandidate(
        candidate.toJSON ? candidate.toJSON() : candidate,
        this._peerConnectionId,
        (successful, data) => {
          if (successful) {
            this.remoteDescription = new RTCSessionDescription(data);
            resolve();
          } else {
            // XXX: This should be OperationError
            reject(new Error('Failed to add ICE candidate'));
          }
      });
    });
  }

  getStats() {
    return WebRTCModule.peerConnectionGetStats(this._peerConnectionId)
        .then( data =>  {
           /* On both Android and iOS it is faster to construct a single
            JSON string representing the Map of StatsReports and have it
            pass through the React Native bridge rather than the Map of
            StatsReports. While the implementations do try to be faster in
            general, the stress is on being faster to pass through the React
            Native bridge which is a bottleneck that tends to be visible in
            the UI when there is congestion involving UI-related passing.

            TODO Implement the logic for filtering the stats based on
            the sender/receiver
            */
            return new Map(JSON.parse(data));
        });
  }

  getLocalStreams() {
    return this._localStreams.slice();
  }

  getReceivers() {
    return this.getTransceivers().map(t => t.receiver)
  }

  getRemoteStreams() {
    return this._remoteStreams.slice();
  }

  getSenders() {
    return this.getTransceivers().filter(t => !!t).map(t => t.sender)
  }

  getTransceivers() {
    return this._transceivers.slice();
  }
  close() {
    WebRTCModule.peerConnectionClose(this._peerConnectionId);
  }

  _getTrack(streamReactTag, trackId): MediaStreamTrack {
    const stream
      = this._remoteStreams.find(
          stream => stream._reactTag === streamReactTag);

    return stream && stream._tracks.find(track => track.id === trackId);
  }

  _findTransceiver(id): RTCRtpTransceiver {
    return this._transceivers.filter(t1 => !!t1).find(t => t.id === id)
  }

  _getTransceiver(state): RTCRtpTransceiver {
    const existing = this._findTransceiver(state.id);
    if (existing) {
      existing._updateState(state);
      return existing;
    } else {
      let res = new RTCRtpTransceiver(this._peerConnectionId, state, (s) => this._mergeState(s));
      this._transceivers.push(res);
      return res;
    }
  }

  _mergeState(state): void {
    if (!state) {
      return;
    }

    // Merge Transceivers states
    if (state.transceivers) {
      // Apply states
      for(let transceiver of state.transceivers) {
        this._getTransceiver(transceiver);
      }
      // Restore Order
      this._transceivers =
        this._transceivers.map((_, i) => this._findTransceiver(state.transceivers[i]?.id)).filter(t => !!t);
    }
  }

  _unregisterEvents(): void {
    this._subscriptions.forEach(e => e.remove());
    this._subscriptions = [];
  }

  _registerEvents(): void {
    this._subscriptions = [
      EventEmitter.addListener('peerConnectionOnRenegotiationNeeded', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.dispatchEvent(new RTCEvent('negotiationneeded'));
      }),
      EventEmitter.addListener('peerConnectionIceConnectionChanged', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.iceConnectionState = ev.iceConnectionState;
        this.dispatchEvent(new RTCEvent('iceconnectionstatechange'));
        if (ev.iceConnectionState === 'closed') {
          // This PeerConnection is done, clean up event handlers.
          this._unregisterEvents();
        }
      }),
      EventEmitter.addListener('peerConnectionStateChanged', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.connectionState = ev.connectionState;
        this.dispatchEvent(new RTCEvent('connectionstatechange'));
        if (ev.connectionState === 'closed') {
          // This PeerConnection is done, clean up event handlers.
          this._unregisterEvents();
        }
      }),
      EventEmitter.addListener('peerConnectionSignalingStateChanged', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.signalingState = ev.signalingState;
        this.dispatchEvent(new RTCEvent('signalingstatechange'));
      }),
      EventEmitter.addListener('peerConnectionAddedStream', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        const stream = new MediaStream(ev);
        this._remoteStreams.push(stream);
        this.remoteDescription = new RTCSessionDescription(ev.sdp);
        this.dispatchEvent(new MediaStreamEvent('addstream', {stream}));
      }),
      EventEmitter.addListener('peerConnectionStartedReceivingOnTransceiver', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this._getTransceiver(ev.transceiver);
      }),
      EventEmitter.addListener('peerConnectionAddedReceiver', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        if (!ev.streams.length || !ev.receiver) {
          return;
        }
        const streams = ev.streams.map(s => new MediaStream(s));
        const track = new MediaStreamTrack(ev.receiver.track);

        this.dispatchEvent(new MediaStreamTrackEvent("track", { track, streams }));
      }),
      EventEmitter.addListener('peerConnectionRemovedStream', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        const stream = this._remoteStreams.find(s => s._reactTag === ev.streamId);
        if (stream) {
          const index = this._remoteStreams.indexOf(stream);
          if (index !== -1) {
            this._remoteStreams.splice(index, 1);
          }
        }
        this.remoteDescription = new RTCSessionDescription(ev.sdp);
        this.dispatchEvent(new MediaStreamEvent('removestream', {stream}));
      }),
      EventEmitter.addListener('mediaStreamTrackMuteChanged', ev => {
        if (ev.peerConnectionId !== this._peerConnectionId) {
          return;
        }
        const track = this._getTrack(ev.streamReactTag, ev.trackId);
        if (track) {
          track.muted = ev.muted;
          const eventName = ev.muted ? 'mute' : 'unmute';
          track.dispatchEvent(new MediaStreamTrackEvent(eventName, {track}));
        }
      }),
      EventEmitter.addListener('peerConnectionGotICECandidate', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.localDescription = new RTCSessionDescription(ev.sdp);
        const candidate = new RTCIceCandidate(ev.candidate);
        const event = new RTCIceCandidateEvent('icecandidate', {candidate});
        this.dispatchEvent(event);
      }),
      EventEmitter.addListener('peerConnectionIceGatheringChanged', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        this.iceGatheringState = ev.iceGatheringState;

        if (this.iceGatheringState === 'complete') {
          this.localDescription = new RTCSessionDescription(ev.sdp);
          this.dispatchEvent(new RTCIceCandidateEvent('icecandidate', null));
        }

        this.dispatchEvent(new RTCEvent('icegatheringstatechange'));
      }),
      EventEmitter.addListener('peerConnectionDidOpenDataChannel', ev => {
        if (ev.id !== this._peerConnectionId) {
          return;
        }
        const channel = new RTCDataChannel(ev.dataChannel);
        this.dispatchEvent(new RTCDataChannelEvent('datachannel', {channel}));
      }),
      EventEmitter.addListener('peerConnectionOnRenegotiationNeeded', ev => {}),
    ];
  }

  /**
   * Creates a new RTCDataChannel object with the given label. The
   * RTCDataChannelInit dictionary can be used to configure properties of the
   * underlying channel such as data reliability.
   *
   * @param {string} label - the value with which the label attribute of the new
   * instance is to be initialized
   * @param {RTCDataChannelInit} dataChannelDict - an optional dictionary of
   * values with which to initialize corresponding attributes of the new
   * instance such as id
   */
  createDataChannel(label: string, dataChannelDict?: ?RTCDataChannelInit) {
    if (dataChannelDict && 'id' in dataChannelDict) {
      const id = dataChannelDict.id;
      if (typeof id !== 'number') {
        throw new TypeError('DataChannel id must be a number: ' + id);
      }
    }

    const channelInfo = WebRTCModule.createDataChannel(
        this._peerConnectionId,
        label,
        dataChannelDict);

    if (channelInfo === null) {
      throw new TypeError('Failed to create new DataChannel');
    }

    return new RTCDataChannel(channelInfo);
  }
}
