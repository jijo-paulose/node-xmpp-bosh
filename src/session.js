var uuid = require('node-uuid');
var us = require('underscore');
var dutil = require('./dutil.js');
var helper = require('./helper.js');
var response = require('./response.js');
var assert = require('assert').ok;


var toNumber = us.toNumber;
var sprintf = dutil.sprintf;
var sprintfd = dutil.sprintfd;
var log_it = dutil.log_it;

var BOSH_XMLNS = 'http://jabber.org/protocol/httpbind'; //TODO: might not be required

function Sessions(bosh_options, bep) {

    this._bosh_options = bosh_options;

    this._bep = bep;

    this._sid_state = {
    };

    this._sid_info = {
        length    : 0,     // Stores the number of active sessions
        total    : 0     // Stores the total number of sessions
    };

    // This holds the terminate condition for terminated sessions. Both this,
    // and terminated_streams are used when the connection between nxb and xmpp
    // server breaks and all the session related info is wiped out. We preserve
    // the condition in this case to let the client know why was its connection
    // broken.
    this._terminated_sessions = {
    };

}

// Ideally, the session_* functions shouldn't worry about anything except for 
// session state maintenance. They should specifically NOT know about streams.
// There may be some exceptions where the abstractions leak into one another, 
// but they should be the exceptions (and there should be a good reason for 
// such an occurence) and not the rule.
// 
Sessions.prototype = {

    get_active_no: function() {
        return this._sid_info.length;
    },

    get_total_no: function() {
        return this._sid_info.total;
    },

    //Fetches a BOSH session object given a BOSH stanza (<body> tag)
    get_session: function(node) {
        var sid = node.attrs.sid;
        var session = sid ? this._sid_state[sid] : null;
        return session;
    },

    get_sessions_obj: function() {
        return this._sid_state;
    },

    add_session: function(node, res) {
        var self = this;
        var session = new Session(node, this._bosh_options, this._bep,
            function(session, condition) {
                helper.save_terminate_condition_for_wait_time(self._terminated_sessions,
                    session.SID(), condition, session.wait());
                delete self._sid_state[session.SID()];
                self.stat_session_terminate();
            });
        session.reset_session_inactivity_timeout();
        session.add_held_http_connection(node.attrs.rid, res);
        this._sid_state[session.SID()] = session;
        this.stat_session_add();
        return session;
    },

    send_session_terminate_invalid_session_response: function(res, node) {
        var terminate_condition;
        if (this._terminated_sessions[node.attrs.sid]) {
            terminate_condition = this._terminated_sessions[node.attrs.sid].condition;
        }
        var attrs = {
            condition    : terminate_condition || 'item-not-found',
            message        : terminate_condition ? '' : 'Invalid session ID'
        }
        ro = new response.Response(res, null, this._bosh_options);
        ro.send_termination_stanza(attrs);
    },

    // Coded according to the rules mentioned here:
    // http://xmpp.org/extensions/xep-0124.html#session-request
    // Even though it says SHOULD for everything we expect, we violate the XEP.
    is_session_creation_packet: function(node) {
        var ia = dutil.inflated_attrs(node);
        return node.attrs.to &&
            node.attrs.wait &&
            node.attrs.hold && !node.attrs.sid &&
            ia.hasOwnProperty('urn:xmpp:xbosh:version');
    },

    stat_session_add: function() {
        ++this._sid_info.length;
        ++this._sid_info.total;
    },

    stat_session_terminate: function() {
        --this._sid_info.length;
    }

}


// This encapsulates the state for the BOSH session
//
// Format: {
//   sid: {
//     sid:
//     rid:
//     wait:
//     hold:
//     res: [ An array of response objects (format is show below) ]
//     pending: [ An array of pending responses to send to the client ]
//     has_next_tick: true if a nextTick handler for this session has
//       been registered, false otherwise
//     ... and other jazz ...
//   }
// }
//
// Format of a single response object:
//
// {
//   res: HTTP response object (obtained from node.js)
//   timeout: A timeout, after which an empty <body> packet will be
//            sent on this response object
//   rid: The 'rid' of the request to which this response object is
//        associated
// }

function Session(node, options, bep, call_on_terminate) {
    this._on_terminate = call_on_terminate;
    this._options = options;
    this._bep = bep;
    this._sid = uuid();
    this._rid = Math.floor(toNumber(node.attrs.rid));
    this._wait = Math.floor(toNumber(node.attrs.wait));
    this._hold = Math.floor(toNumber(node.attrs.hold));
    // The 'inactivity' attribute is an extension
    this._inactivity = Math.floor(toNumber(node.attrs.inactivity ||
        options.DEFAULT_INACTIVITY()));
    this._content = "text/xml; charset=utf-8";

    if (this._hold <= 0) {
        this._hold = 1;
    } // Sanitize hold

    if (node.attrs.content) { // If the client included a content attribute, we mimic it.
        this._content = node.attrs.content;
    }

    if (node.attrs.ack) { // If the client included an ack attribute, we support ACKs.
        this._ack = 1;
    }

    if (node.attrs.route) {
        this._route = node.attrs.route;
    }

    // The 'ua' (user-agent) attribute is an extension.
    if (node.attrs.ua) {
        this._ua = node.attrs.ua;
    }

    this._hold = this._hold > options.MAX_BOSH_CONNECTIONS() ?
        options.MAX_BOSH_CONNECTIONS() : this._hold;

    this._res = [ ]; // res needs is sorted in 'rid' order.

    // Contains objects of the form:
    // { response: <The body element>, sstate: <The stream state object> }
    this._pending = [ ];

    // This is just an array of strings holding the stream names
    this._streams = [ ];

    // A set of responses that have been sent by the BOSH server, but
    // not yet ACKed by the client.
    // Format: { rid: { response: [Response Object with <body> wrapper],
    // ts: new Date() } }
    this._unacked_responses = { };

    // A set of queued requests that will become complete when "hasoles" in the
    // request queue are filled in by packets with the right 'rids'
    this._queued_requests = { };

    // The Max value of the 'rid' (request ID) that has been sent by BOSH to the
    // client. i.e. The highest request ID responded to by us.
    this._max_rid_sent = this._rid - 1;

    if (this._inactivity) {
        // We squeeze options.inactivity between the min and max allowable values
        this._inactivity = [ Math.floor(toNumber(this._inactivity)),
            options.MAX_INACTIVITY(),
            options.DEFAULT_INACTIVITY()].sort(dutil.num_cmp)[1];
    }
    else {
        this._inactivity = options.DEFAULT_INACTIVITY();
    }

    if (this._wait <= 0 || this._wait > this._inactivity) {
        this._wait = Math.floor(this._inactivity * 0.8);
    }

    this._window = options.WINDOW_SIZE();

    // There is just 1 inactivity timeout for the whole BOSH session
    // (as opposed to for each response as it was earlier)
    this._timeout = null;

    // This BOSH session have a pending nextTick() handler?
    this._has_next_tick = false;

}

Session.prototype = {
    SID: function() {
        return this._sid;
    },

    rid: function() {
        return this._rid;
    },

    add_stream: function(stream) {
        this._streams.push(stream);
    },

    delete_stream: function(stream) {
        var pos = this._streams.indexOf(stream);
        if (pos !== -1) {
            this._streams.splice(pos, 1);
        }
    },

    ack: function() {
        return this._ack;
    },

    wait: function() {
        return this._wait;
    },

    get_only_stream: function() {
        if (this._streams.length === 1) {
            // Let's pretend that the stream name came along
            // with this request. This is mentioned in the XEP.
            return this._streams[0];
        }
        else
            return null;
    },

    // is_valid_packet() handles the rid range checking
    // Check the validity of the packet 'node' wrt the
    // state of this BOSH session 'state'. This mainly checks
    // the 'sid' and 'rid' attributes.
    // Also limit the number of attributes in the <body> tag to 20
    is_valid_packet:function(node) {
        log_it("DEBUG",
            sprintfd("SESSION::%s::is_valid_packet::node.attrs.rid:%s, state.rid:%s",
                this._sid, node.attrs.rid, this._rid)
        );

        // Allow variance of "window" rids on either side. This is in violation
        // of the XEP though.
        return node.attrs.sid && node.attrs.rid &&
            node.attrs.rid > this._rid - this._window - 1 &&
            node.attrs.rid < this._rid + this._window + 1 &&
            Object.keys(node.attrs).length < 21;
    },

    add_request_to_queue: function(node) {
        node.attrs.rid = toNumber(node.attrs.rid);
        this._queued_requests[node.attrs.rid] = node;

        var nodes = [ ];
        // Process all queued requests
        var _queued_request_keys = Object.keys(this._queued_requests).map(toNumber);
        _queued_request_keys.sort(dutil.num_cmp);

        var self = this;
        _queued_request_keys.forEach(function(rid) {
            if (rid === self._rid + 1) {
                // This is the next logical packet to be processed.
                nodes = nodes.concat(self._queued_requests[rid].children);
                delete self._queued_requests[rid];

                // Increment the 'rid'
                self._rid += 1;
                log_it("DEBUG", sprintfd(
                    "SESSION::%s::updated RID to: %s", self._sid, self._rid));
            }
        });

        return nodes;
        // Alternatively, we can also call ourselves recursively to process
        // the pending queue. That way, we won't need to sort() the queued
        // requests. Think about it...
    },

    // Adds the response object 'res' to the list of held response
    // objects for this BOSH session. Also sets the associated 'rid' of
    // the response object 'res' to 'rid'
    add_held_http_connection: function (rid, res) {
        var ro = new response.Response(res, rid, this._options);
        // If a client makes more connections than allowed, trim them.
        // http://xmpp.org/extensions/xep-0124.html#overactive
        //
        // This is currently not being enforced. See comment #001
        //
        // However, if the client specifies a 'hold' value greater than
        // 'MAX_BOSH_CONNECTIONS', then the session will be terminated
        // because of the rule below.
        if (this._res.length > this._options.MAX_BOSH_CONNECTIONS()) {
            // Just send the termination message and destroy the socket.
            var condition = 'policy-violation';
            this.send_session_terminate_response(ro, condition);

            this._streams.forEach(function(stream) {
                stream.terminate(condition);
            });

            this.terminate(condition);
            return;
        }

        ro.set_socket_options(this._wait);
        var self = this;
        ro.set_timeout(function() {
            var pos = self._res.indexOf(ro);
            if (pos === -1) {
                return;
            }
            // Remove self from list of held connections.
            self._res.splice(pos, 1);
            // Send back an empty body element.
            // We don't add this to unacked_responses since it's wasteful. NO
            // WE ACTUALLY DO add it to unacked_responses
            self._send_no_requeue(ro, helper.$body());
        }, this._wait * 1000);

        log_it("DEBUG", sprintfd(
            "SESSION::%s::adding a response object. Holding %s response objects",
            this._sid, this._res.length)
        );

        // Insert into its correct position (in RID order)
        var pos;
        for (pos = 0; pos < this._res.length && this._res[pos].rid < ro.rid; ++pos) {
        }
        this._res.splice(pos, 0, ro);
    },

    // Note: Even if we terminate a non-empty BOSH session, it is
    // OKAY since the 'inactivity' timeout will eventually timeout
    // all open streams (on the XMPP server side)
    terminate: function (condition) {
        if (this._streams.length !== 0) {
            log_it("DEBUG", sprintfd(
                "SESSION::%s::Terminating potentially non-empty BOSH session",
                this._sid));
        }

        // We use get_response_object() since it also calls clearTimeout, etc...
        // for us for free.
        var ro = this.get_response_object();
        while (ro) {
            ro.send_empty_body();
            ro = this.get_response_object();
        }

        assert(this._res.length === 0);

        // Unset the inactivity timeout
        this._unset_session_inactivity_timeout();

        this._on_terminate(this, condition);
    },

    // Disables the BOSH session inactivity timeout
    _unset_session_inactivity_timeout: function() {
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = null;
        }
    },

    // Resets the BOSH session inactivity timeout
    reset_session_inactivity_timeout: function() {
        if (this._timeout) {
            clearTimeout(this._timeout);
        }

        log_it("DEBUG", sprintfd("SESSION::%s::setting a timeout of '%s' sec",
            this._sid, this._inactivity + 10));

        var self = this;
        this._timeout = setTimeout(function() {
            log_it("DEBUG", sprintfd(
                "SESSION::%s::terminating BOSH session due to inactivity", self._sid));

            // Raise a no-client event on pending as well as unacked responses.
            var _p = us.pluck(self._pending, 'response');

            var _uar = Object.keys(self._unacked_responses).map(toNumber)
                .map(function(rid) {
                    return self._unacked_responses[rid].response;
                });

            var all = _p.concat(_uar);
            all.forEach(function(response) {
                self._bep.emit('no-client', response);
            });

            // Pretend as if the client asked to terminate the stream
            self._unset_session_inactivity_timeout();
            self.handle_client_stream_terminate_request(null, [ ]);
        }, (this._inactivity + 10 /* 10 sec grace period */) * 1000);
    },

    // These functions actually send responses to the client

    send_session_terminate_invalid_packet_response: function(res, node) {
        log_it("WARN", sprintfd("SESSION::%s::NOT a Valid packet", this._sid));
        var attrs = {
            condition    : 'item-not-found',
            message        : 'Invalid packet'
        };
        if (node.attrs.stream) {
            attrs.stream = node.attrs.stream;
        }
        // Terminate the session (thanks @satyam.s). The XEP mentions this as
        // a MUST, so we humbly comply
        this.handle_client_stream_terminate_request(null, [ ], 'item-not-found');
        ro = new response.Response(res, null, this._options);
        ro.send_termination_stanza(attrs);
    },

    // ro: The response object to use
    // condition: (optional) A string which specifies the condition to
    //     send to the client as to why the session was closed.
    send_session_terminate_response: function(ro, condition) {
        log_it('DEBUG', sprintfd("SESSION::%s::send_session_terminate_response(%s, %s)",
            this._sid, (!!ro), condition || ''));
        var attrs = { };
        if (condition) {
            attrs.condition = condition;
        }
        var msg = helper.$terminate(attrs);
        this._send_no_requeue(ro, msg);
    },

    send_session_creation_response: function(stream) {
        // We _must_ get a response object. If we don't, there is something
        // seriously messed up. Log this.
        if (this._res.length === 0) {
            log_it('DEBUG', sprintfd(
                "SESSION::%s::s_s_c_r::Could not find a response object for stream:%s",
                this._sid, stream.NAME()));
            return false;
        }

        var attrs = {
            stream                : stream.NAME(),
            sid                    : this._sid,
            wait                : this._wait,
            ver                    : this._ver,
            polling                : this._inactivity / 2,
            inactivity            : this._inactivity,
            requests            : this._options.WINDOW_SIZE(),
            hold                : this._hold,
            from                : stream.to(),
            content                : this._content,
            "xmpp:restartlogic"    : "true",
            "xmlns:xmpp"        : 'urn:xmpp:xbosh',
            // secure:     'false', // TODO
            // 'ack' is set by the client. If the client sets 'ack', then we also
            // do acknowledged request/response. The 'ack' attribute is set
            // by the send_no_requeue function since it is the last one to
            // touch responses before they go out on the wire.
            // Handle window size mismatches
            "window"            : this._options.WINDOW_SIZE()
        };

        if (stream.from()) {
            // This is *probably* the JID of the user. Send it back as 'to'.
            // This isn't mentioned in the spec.
            attrs.to = stream.from();
        }

        var msg = helper.$body(attrs);
        this.enqueue_response(msg, stream);
    },

    // The streams to terminate. We start off by assuming that
    // we have to terminate all streams on this session
    _get_streams_to_terminate: function (stream) {
        var streams = this._streams;
        // If we have a valid stream to terminate, then we reduce
        // our set of streams to terminate to only this one
        if (stream) {
            streams = [ stream ];
        }
        // Streams to terminate
        var stt = streams.filter(us.isTruthy);
        // Streams in error
        var sie = streams.filter(us.isFalsy);
        // From streams, remove all entries that are
        // null or undefined, and log this condition.
        if (sie.length > 0) {
            log_it("WARN", sprintfd(
                "SESSION::%s::get_streams_to_terminate::%s streams are in error",
                this._sid, sie.length));
        }
        return stt;
    },

    // This function handles a stream terminate request from the client.
    // It assumes that the client sent a stream terminate request.
    // i.e. That the request is valid. If we use this to respond to an
    // invalid request, we need to respond to that request separately.
    //
    // 'condition' is an optional parameter. If not specified, no condition
    // (reason) shall be sent in the terminate response
    handle_client_stream_terminate_request: function(stream, nodes, condition) {
        var streams_to_terminate = this._get_streams_to_terminate(stream);
        var will_terminate_all_streams = streams_to_terminate.length ===
            this._streams.length;

        var self = this;
        streams_to_terminate.forEach(function(stream) {
            if (nodes.length > 0) {
                self._emit_nodes_event(nodes, stream);
            }

            // Send stream termination response
            // http://xmpp.org/extensions/xep-0124.html#terminate
            if (!will_terminate_all_streams) {
                stream.send_stream_terminate_response(condition);
            }

            stream.terminate(condition);
            self._bep.emit('stream-terminate', stream.get_api_state());
        });

        // Terminate the session if all streams in this session have
        // been terminated.
        if (this._streams.length === 0) {
            // Send the session termination response to the client.
            // Copy the condition if mentioned.
            this.send_session_terminate_response(this.get_response_object(), condition);
            // And terminate the rest of the held response objects.
            this.terminate(condition);
        }
    },

    // Fetches a "held" HTTP response object that we can potentially send responses to.
    get_response_object: function() {
        var res = this._res;
        var ro = res.length > 0 ? res.shift() : null;
        if (ro) {
            ro.clear_timeout();
            log_it("DEBUG", sprintfd(
                "SESSION::%s::Returning response object with rid: %s",
                this._sid, ro.RID())
            );
        }
        log_it("DEBUG", sprintfd("SESSION::%s::Holding %s response objects",
            this._sid, (res ? res.length : 0))
        );
        return ro;
    },

    // There is a subtle bug here. If the sending of this response fails
    // then it is appended to the queue of pending responses rather than
    // being added to the right place. This is because we rely on
    // enqueue_response() to append it back to the list of pending
    // responses.
    //
    // We hope for this to not occur too frequently.
    //
    // The right way to do it would be to always stamp the response
    // with the 'rid' when sending and add it to the list of buffered
    // responses. However, in places with a bad network this will
    // degrade the experience for the client. Hence, we stick with
    // the current implementation.
    //
    _pop_and_send: function() {
        var ro = this.get_response_object();
        log_it("DEBUG",
            sprintfd("SESSION::%s::pop_and_send: ro:%s, this._pending.length: %s",
                this._sid, us.isTruthy(ro), this._pending.length));

        if (ro && this._pending.length > 0) {
            var _p = this._pending.shift();
            var response = _p.response;
            var stream = _p.stream;

            // On error, try the next one or start the timer if there
            // is nothing left to try.
            var self = this;
            ro.set_error(function() {
                log_it("DEBUG", sprintfd(
                    "SESSION::%s::error sending response on rid: %s", self._sid,
                    ro.RID()));
                if (self._res.length > 0) {
                    // Try the next one
                    self.enqueue_response(response, stream);
                }
                else {
                    self._on_no_client_found(response, stream);
                }
            });
            this._send_no_requeue(ro, response);
            // We try sending more queued responses
            this.send_pending_responses();
        }
    },

    // We add this response to the list of pending responses.
    // If and when a new HTTP request on this BOSH session is detected,
    // it will clear the pending response and send the packet
    // (in FIFO order).
    on_no_client_found: function(response, stream) {
        var _po = {
            response: response,
            stream: stream
        };
        this._pending.push(_po);
    },

    /* Check if we can merge the XML stanzas in 'response' and some
     * response in 'pending'.
     *
     * The way this check is made is that all the attributes of the
     * outer (body) element are checked, and if found equal, the
     * two are said to be the equal.
     *
     * When 2 body tags are found to be equal, they can be merged,
     * and the position of the first such response in 'pending'
     * is returned.
     *
     * Since the only *special* <body> tag that is created for a
     * stream before sending is the terminate response, we can
     * be sure that any response that has an XMPP payload is a
     * plain-ol body tag and we will always merge with the right
     * response and responses will be in-order.
     *
     */
    _can_merge: function(response) {
        var i;
        for (i = 0; i < this._pending.length; ++i) {
            if (us.isEqual(response.attrs, this._pending[i].response.attrs)) {
                return i;
            }
        }
        return -1;
    },

    _merge_or_push_response: function(response, stream) {
        var merge_index = this._can_merge(response);
        log_it('DEBUG', sprintfd(
            'SESSION::%s::Merging with response at index: %s', this._sid, merge_index));

        if (merge_index !== -1) {
            // Yes, it is the same stream. Merge the responses.
            var _presp = this._pending[merge_index].response;

            response.children.forEach(function(child) {
                //
                // Don't forget to reset 'parent' since reassigning
                // children w/o assigning the 'parent' can be
                // DISASTROUS!! You'll never know what hit you
                //
                child.parent = _presp;
                _presp.children.push(child);
            });
        }
        else {
            this._pending.push({
                response: response,
                stream: stream
            });
        }
    },

    /* Enqueue a response. Requeue if the sending fails.
     *
     * This function tries to merge the response with an existing
     * queued response to be sent on this stream (if merging them
     * is feasible). Subsequently, it will pop the first queued
     * response to be sent on this BOSH session and try to send it.
     * In the unfortunate event that it can NOT be sent, it will be
     * added to the back to the queue (not the front). This can be
     * the cause of very rare unordered responses.
     *
     * If you see unordered responses, this bit needs to be fixed
     * to maintain state.pending as a priority queue rather than
     * a simple array.
     *
     * Note: Just adding to the front of the queue will NOT work,
     * so don't even waste your time trying to fix it that way.
     *
     */
    enqueue_response: function (response, stream) { //TODO: Correct Logic

        log_it("DEBUG", sprintfd("SESSION::%s::enqueue_response", this._sid));

        // Merge with an existing response, or push it as a new response
        this._merge_or_push_response(response, stream);

        if (!this._has_next_tick) {
            var self = this;
            process.nextTick(function() {
                self._has_next_tick = false;
                self._pop_and_send();
            });
            this._has_next_tick = true;
        }
    },

    // If the client has enabled ACKs, then acknowledge the highest request
    // that we have received till now -- if it is not the current request.
    _get_highest_rid_to_ack: function(rid, msg) {
        if (this._ack) {
            this._unacked_responses[this._rid] = {
                response: msg,
                ts: new Date(),
                rid: rid
            };
            this._max_rid_sent = Math.max(this._max_rid_sent, rid);
            if (rid < this._rid) {
                return this._rid();
            }
        }
    },

    // Send a response, but do NOT requeue if it fails
    _send_no_requeue: function (ro, msg) {
        log_it("DEBUG", sprintfd(
            "SESSION::%s::send_no_requeue, ro valid: %s", this._sid, !!ro));
        if (us.isFalsy(ro)) {
            return;
        }
        log_it("DEBUG", sprintfd(
            "SESSION::%s::send_no_requeue, rid: %s", this._sid, ro.RID()));
        var ack = this._get_highest_rid_to_ack(ro.RID(), msg);
        if (ack)
            msg.attrs.ack = ack;
        var res_str = msg.toString();
        log_it("DEBUG", sprintfd("SESSION::%s::send_no_requeue:writing response: %s"
            , this._sid, res_str));
        ro.send_response(res_str);
    },

    send_pending_responses: function() {
        log_it("DEBUG", sprintfd(
            "SESSION::%s::send_pending_responses::state.pending.length: %s", this._sid,
            this._pending.length));
        if (this._pending.length > 0 && this._res.length > 0) {
            this._pop_and_send();
        }
    },

    // Raise the 'nodes' event on 'bep' for every node in 'nodes'.
    // If 'sstate' is falsy, then the 'nodes' event is raised on
    // every open stream in the BOSH session represented by 'state'.
    emit_nodes_event: function(nodes, stream) {
        if (!stream) {
            // No stream name specified. This packet needs to be
            // broadcast to all open streams on this BOSH session.
            log_it("DEBUG", function() {
                return sprintf(
                    "SESSION::emitting nodes to all streams:No Stream Name specified:%s"
                    , nodes);
            });
            var self = this;
            this._streams.forEach(function(stream) {
                if (stream) {
                    self._bep.emit('nodes', nodes, stream.get_api_state());
                }
            });
        }
        else {
            log_it("DEBUG", function() {
                return sprintf("SESSION::%s:emitting nodes:%s", stream.NAME(), nodes);
            });
            this._bep.emit('nodes', nodes, stream.get_api_state());
        }
    },

    // If the client has made more than "hold" connections
    // to us, then we relinquish the rest of the connections
    respond_to_extra_held_response_objects: function() {
        while (this._res.length > this._hold) {
            log_it("DEBUG", sprintfd(
                "Session::In r_t_e_h_r_o %s:: state res length: %s::state hold:%s",
                this._sid, this._res.length, this._hold));
            var ro = this.get_response_object();
            this._send_no_requeue(ro, helper.$body());
        }
    },

    /* Fetches a random stream from the BOSH session. This is used to
     * send a sstate object to function that require one even though
     * the particular response may have nothing to do with a stream
     * as such.
     */
    _get_random_stream: function() {
        if (this._streams.length === 0) {
            var estr = sprintf("SESSION::%s::session object has no streams", this._sid);
            log_it("ERROR", estr);
            return null;
        }
        var stream = this._streams[0];
        return stream;
    },

    /* This function sends 'response' immediately. i.e. It does not
     * queue it up and this response may reach on an RID that is
     * not in sequence.
     */
    _send_immediate: function(res, response) {
        log_it("DEBUG", sprintfd("SESSION::send_immediate:%s", response));
        var ro = new response.Response(res, null, this._options);
        ro.send_response(response);
    },

    handle_acknowledgements: function(node, res) {
        if (this._ack) { // Has the client enabled ACKs?
            /* Begin ACK handling */
            var _uar_keys = Object.keys(this._unacked_responses).map(toNumber);
            //We are fairly generous
            if (_uar_keys.length > this._options.WINDOW_SIZE() * 4) {
                // The client seems to be buggy. It has not ACKed the
                // last WINDOW_SIZE * 4 requests. We turn off ACKs.
                delete this._ack;
                log_it("WARN", sprintfd("SESSION::%s::disabling ACKs", this._sid));
                this._unacked_responses = { };
            }
            if (!node.attrs.ack) {
                // Assume that all requests up to rid-1 have been responded to
                // http://xmpp.org/extensions/xep-0124.html#rids-broken
                node.attrs.ack = state.rid - 1;
            }
            if (node.attrs.ack) {
                // If the request from the client includes an ACK, we delete all
                // packets with an 'rid' less than or equal to this value since
                // the client has seen all those packets.
                var self = thhis;
                _uar_keys.forEach(function(rid) {
                    if (rid <= node.attrs.ack) {
                        // Raise the 'response-acknowledged' event.
                        self._bep.emit('response-acknowledged',
                            self._unacked_responses[rid], self.get_api_state());
                        delete self._unacked_responses[rid];
                    }
                });
            }

            // Client has not acknowledged the receipt of the last message we sent it.
            if (node.attrs.ack && node.attrs.ack < this._max_rid_sent &&
                this._unacked_responses[node.attrs.ack]) {
                var _ts = this._unacked_responses[node.attrs.ack].ts;
                var ss = this._get_random_stream();
                if (!ss) {
                    var estr = sprintf("BOSH::%s::ss is invalid", this._sid);
                    log_it("ERROR", estr);
                }
                else {
                    // We inject a response packet into the pending queue to
                    // notify the client that it _may_ have missed something.
                    this._pending.push({
                        response: $body({
                            report: node.attrs.ack + 1,
                            time: new Date() - _ts
                        }),
                        stream: ss
                    });
                }
            }

            //
            // Handle the condition of broken connections
            // http://xmpp.org/extensions/xep-0124.html#rids-broken
            //
            // We only handle broken connections for streams that have
            // acknowledgements enabled.
            //
            // We MUST respond on this same connection - We always have
            // something to respond with for any request with an rid that
            // is less than state.rid + 1
            //
            _queued_request_keys = Object.keys(this._queued_requests).map(toNumber);
            _queued_request_keys.sort(dutil.num_cmp);
            var quit_me = false;
            var self = this;
            _queued_request_keys.forEach(function(rid) {
                //
                // There should be exactly 1 'rid' in state.queued_requests that is
                // less than state.rid+1
                //
                if (rid < self._rid + 1) {
                    log_it("DEBUG", sprintfd(
                        "SESSION::%s::qr-rid: %s, state.rid: %s", self._sid, rid,
                        self._rid));

                    delete self._queued_requests[rid];

                    if (self._unacked_responses.hasOwnProperty(rid)) {
                        //
                        // Send back the original response on this conection itself
                        //
                        log_it("DEBUG", sprintfd(
                            "SESSION::%s::re-sending unacked response: %s",
                            self._sid, rid));
                        self._send_immediate(res, self._unacked_responses[rid].response);
                        quit_me = true;
                    }
                    else if (rid >= self._rid - self._window - 2) {
                        //
                        // Send back an empty body since it is within the range. We assume
                        // that we didn't send anything on this rid the first time around.
                        //
                        // There is a small issue here. If a client re-sends a request for
                        // an 'rid' that it has already acknowledged, it will get an empty
                        // body the second time around. The client is to be blamed for its
                        // stupidity and not us.
                        //
                        log_it("DEBUG", sprintfd(
                            "SESSION::%s::sending empty BODY for: %s", self._sid, rid));
                        self._send_immediate(res, $body());
                        quit_me = true;
                    }
                    else {
                        //
                        // Terminate this session. We make the rest of the code believe
                        // that the client asked for termination.
                        //
                        // I don't think that control will ever reach here since the
                        // validation for the 'rid' being in a permissible range has
                        // already been made.
                        //
                        // Note: Control DOES reach here. We need to figure out WHY.
                        //
                        dutil.copy(node.attrs, { //TODO: Might be moved to helper.
                            type: 'terminate',
                            condition: 'item-not-found',
                            xmlns: BOSH_XMLNS
                        });
                    }
                }
            });

            return quit_me;
        }
    },

    // Should we process this packet?
    should_process_packet: function(node) {
        if (node.attrs.rid > this._rid) {
            // Not really... The request will remain in queued_requests
            // and the response object has already been held
            log_it("INFO", sprintfd("SESSION::%s::not processing packet: %s",
                this._sid, node));
            return false;
        }
        return true;
    },

    is_max_streams_violation: function() {
        return (this._streams.length > this._options.MAX_STREAMS_PER_SESSION());
    },

    // returns an API compatible state.
    get_api_state: function() {
        var self = this;
        var state = {
            sid                     : self._sid,
            rid                     : self._rid,
            wait                    : self._wait,
            hold                    : self._wait,
            inactivity              : self._inactivity,
            content                 : self._content,
            res                     : self._res,
            pending                 : self._pending,
            streams                 : self._get_stream_names(),
            unacked_responses       : self._unacked_responses,
            queued_requests         : self._queued_requests,
            max_rid_sent            : self._max_rid_sent,
            window                  : self._window,
            timeout                 : self._timeout,
            has_next_tick           : self._has_next_tick,
            session                 : self
        };
        if (self._ack) {
            state.ack = self._ack;
        }
        if (self._route) {
            state.route = self._route;
        }
        if (self._ua) {
            state.us = self._ua;
        }
        return state;
    },

    _get_stream_names: function() {
        return this._streams.map(function(stream) {
            return stream.NAME()
        });
    },

    no_of_streams: function() {
        return this._streams.length;
    }
}

exports.Sessions = Sessions;