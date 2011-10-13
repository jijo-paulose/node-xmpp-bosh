// -*-  tab-width:4  -*-

/*
 * Copyright (c) 2011 Dhruv Matani
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

var ltx         = require('ltx');
var dutil       = require('./dutil.js');
var us          = require('underscore');
var sess        = require('./session.js');
var strm        = require('./stream.js');
var helper      = require('./helper.js');
var opt         = require('./options.js');
var bee         = require('./bosh-event-emitter.js');
var http        = require('./http-server.js');
var sprintf     = dutil.sprintf;
var sprintfd    = dutil.sprintfd;
var log_it      = dutil.log_it;

//
// Important links:
// 
// List of BOSH errors for the terminate packet
// http://xmpp.org/extensions/xep-0124.html#errorstatus-terminal
//
// XEP-206
// http://xmpp.org/extensions/xep-0206.html
//
// CORS headers
// https://developer.mozilla.org/En/HTTP_access_control
//

//
// options:
//
// * path
// * port
// * host
// * max_data_held
// * max_bosh_connections
// * window_size
// * default_inactivity
// * max_inactivity
// * http_socket_keepalive
// * http_headers
//


exports.createServer = function (options) {
	//
	// +-------+
	// | NOTE: |
	// +-------+
	//
	// Always ensure that you update the definitions of the objects (in the
	// comments) as and when you add/remove members from them. Please try to
	// keep these object definitions up-to-date since it is the main
	// (and only) place of reference for object structure.
	//

    var started;
    var sessions;
    var streams;
    var bep;
    var bosh_options;
    var server;

    started = new Date(); // When was this server started?

	function get_statistics() {
		var stats = [ ];
		stats.push('<?xml version="1.0" encoding="utf-8"?>');
		stats.push('<!DOCTYPE html>');
		var content = new ltx.Element('html', {
			'xmlns':    'http://www.w3.org/1999/xhtml',
			'xml:lang': 'en'
		})
			.c('head')
			.c('title').t('node-xmpp-bosh').up()
			.up()
			.c('body')
			.c('h1')
			.c('a', {'href': 'http://code.google.com/p/node-xmpp-bosh/'})
			.t('node-xmpp-bosh')
			.up()
			.up()
			.c('h3').t('Bidirectional-streams Over Synchronous HTTP').up()
			.c('p').t(sprintf('Uptime: %s', dutil.time_diff(started, new Date()))).up()
			.c('p').t(sprintf('%s/%s active %s', sessions.get_active_no(),
							sessions.get_total_no(),
							dutil.pluralize(sessions.get_total_no(), 'session'))).up()
			.c('p').t(sprintf('%s/%s active %s', streams.get_active_no(),
							streams.get_total_no(),
							dutil.pluralize(streams.get_total_no(), 'stream'))).up()
			.tree();
		stats.push(content.toString());
		return stats.join('\n');
	}

	function process_bosh_request(res, node) {
		// This will eventually contain all the nodes to be processed.
		var nodes = [ ];

		var session = null;
		var stream = null;

		// Check if this is a session start packet.
		if (sessions.is_session_creation_packet(node)) {
			log_it("DEBUG", "BOSH::Session creation");
			session = sessions.add_session(node, res);
			stream = streams.add_stream(session, node);

			// Respond to the client.
			session.send_creation_response(stream);
            nodes = node.children;

            // NULL out res so that it is not added again
            res = null;

            //
            // In any case, we should process the XML nodes.
            //
            if (nodes.length > 0) {
                session.emit_nodes_event(nodes, stream);
            }

        } else {
            session = sessions.get_session(node);
            if (!session) { //No (valid) session ID in BOSH request. Not phare enuph.
				sessions.send_invalid_session_terminate_response(res, node);
				return;
            }
            try {
				// This is enclosed in a try/catch block since invalid requests
				// at this point MAY not have these attributes
				log_it("DEBUG", sprintfd("BOSH::%s::RID: %s, state.RID: %s",
                    session.sid, node.attrs.rid, session.rid));
			} catch (ex) { }

			// Check the validity of the packet and the BOSH session
			if (!session.is_valid_packet(node)) {
				session.send_invalid_packet_terminate_response(res, node);
				return;
			}

			// Reset the BOSH session timeout
			session.reset_inactivity_timeout();

            session.add_request_to_queue(node, res);
            if (!session.process_requests(streams)) {
                return;
            }
		} // else (not session start)


		// Comment #001
		//
		// Respond to any extra "held" response objects that we actually
		// should not be holding on to (Thanks Stefan)
		//
		// This is in disagreement with the XEP
		// http://xmpp.org/extensions/xep-0124.html#overactive
		// if the client sent an empty <body/> tag and was overactive
		//
		// However, we do it since many flaky clients and network
		// configurations exist in the wild.
		//
		session.respond_to_extra_held_response_objects();
	}


	function http_error_handler(ex) {
		// We enforce similar semantics as the rest of the node.js for the 'error'
		// event and throw an exception if it is unhandled
		if (!bep.emit('error', ex)) {
			throw new Error(
				sprintf('ERROR on listener at endpoint: http://%s:%s%s',
					options.host, options.port, options.path)
			);
		}
	}

    function xml_parse_and_get_body_tag(data) {
        // Wrap data in <dummy> tags to prevent the billion laughs
        // (XML entity expansion) attack
        // http://www.stylusstudio.com/xmldev/200211/post50610.html
        var node = dutil.xml_parse('<dummy>' + data + '</dummy>');
        if (!node || node.children.length !== 1 || typeof node.children[0].is
                !== 'function' || !node.children[0].is('body')) {
            return null;
        }
        return node.children[0];
    }

	//Called when the 'end' event for the request is fired by the HTTP request handler
	function bosh_request_handler(res, data) {
		var node = xml_parse_and_get_body_tag(data);
		if (!node) {
			res.writeHead(200, bosh_options.HTTP_POST_RESPONSE_HEADERS);
			res.end(helper.$terminate({ condition: 'bad-request' }).toString());
			return;
		}
		log_it("DEBUG", sprintfd("BOSH::Processing request: %s", node));
		process_bosh_request(res, node);
	}

	// When the Connector is able to add the stream, we too do the same and
	// respond to the client accordingly.
	function _on_stream_added(stream) {
		log_it("DEBUG", sprintfd("BOSH::%s::stream-added: %s", stream.state.sid,
			stream.name));
		// Send only if this is the 2nd (or more) stream on this BOSH session.
		// This should work all the time. If anyone finds a case where it will
		// NOT work, please do let me know.
		var session = stream.session;
		if (session.no_of_streams() > 1) {
			stream.send_stream_add_response();
		}
	}

	// When a response is received from the connector, try to send it out to the
	// real client if possible.
	function _on_repsponse(connector_response, stream) {
		log_it("DEBUG", sprintfd("BOSH::%s::%s::response: %s", stream.state.sid,
			stream.name, connector_response));
		var response = helper.$body({
			stream: stream.name
		}).cnode(connector_response).tree();
		var session = stream.session;
		session.enqueue_response(response, stream);
	}

	// This event is raised when the server terminates the connection.
	// The Connector typically raises this even so that we can tell
	// the client (user) that such an event has occurred.
	function _on_terminate(stream, error) {
		// We send a terminate response to the client.
		var condition = error || '';
		stream.send_stream_terminate_response(condition);
		stream.terminate(condition);

		var session = stream.session;
		// Should we terminate the BOSH session as well?
		if (session.no_of_streams() === 0) {
			session.send_terminate_response(session.get_response_object(),
				condition);
			session.terminate(condition);
		}
	}

    bosh_options = new opt.BOSH_Options(options);
    server = new http.HTTPServer(options.port, options.host, get_statistics,
        bosh_request_handler, http_error_handler, bosh_options);
	// The BOSH event emitter. People outside will subscribe to
	// events from this guy. We return an instance of BoshEventPipe
	// to the outside world when anyone calls createServer()
	bep = new bee.BoshEventPipe(server.http_server);
	bep.on('stream-added', _on_stream_added);
	bep.on('response', _on_repsponse);
	bep.on('terminate', _on_terminate);
    sessions = new sess.Sessions(bosh_options, bep);
	streams = new strm.Streams(bosh_options, bep);
	bep.set_session_data(sessions);
	bep.set_stream_data(streams);
	return bep;
};