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


var http   = require('http');
var ws     = require('websocket-server');
var url    = require('url');
var ltx    = require('ltx');
var util   = require('util');
var uuid   = require('node-uuid');
var dutil  = require('./dutil.js');
var us     = require('underscore');
var assert = require('assert').ok;
var qs     = require('querystring');
var EventPipe = require('eventpipe').EventPipe;


var sprintf  = dutil.sprintf;
var sprintfd = dutil.sprintfd;
var log_it   = dutil.log_it;
var toNumber = us.toNumber;

var STREAM_UNOPENED = 1;
var STREAM_OPENED   = 2;

exports.createServer = function(options) {
	console.log("options:", options);

	var sn_state = { };

	function WebSocketEventPipe(bosh_server) {
		this.bosh_server = bosh_server;
	}

	util.inherits(WebSocketEventPipe, EventPipe);

	dutil.copy(WebSocketEventPipe.prototype, {
		stop: function() {
			return websocket_server.close();
		}, 
		stat_stream_add: function() {
			return this.bosh_server.stat_stream_add();
		}, 
		stat_stream_terminate: function() {
			return this.bosh_server.stat_stream_terminate();
		}
	});

	var wsep = new WebSocketEventPipe();

	var websocket_server = ws.createServer({
		server: options.http_server
	});

	wsep.server = websocket_server;

	wsep.on('response', function() {
	});

	wsep.on('terminate', function() {
	});

	websocket_server.on('connection', function(conn) {
		var stream_name = uuid();
		var sstate = {
			name: stream_name, 
			state: STREAM_UNOPENED, 
			conn: conn
		};
		sn_state[stream_name] = sstate;

		conn.on('message', function(message) {
			console.log("message:", message);
			var so_pos = message.search('<stream:stream');
			var _terminate = false;

			if (so_pos !== -1) {
				if (message.search('</stream:stream') === -1) {
					message = message + '</stream:stream>';
				}
				else {
					_terminate = true;
				}
			}

			message = '<dummy>' + message + '</dummy'>;
			
			// TODO: XML parse the message

			nodes = nodes.children;

			if (nodes.length > 0 && typeof nodes[0].is === 'function' && nodes[0].is('stream')) {
				var so_node = nodes[0];
				nodes = nodes.children;

				if (sstate.state === STREAM_UNOPENED) {
					// Start a new stream
					sstate.state = STREAM_OPENED;
					wsep.emit('stream-add', sstate, so_node.attrs);
				}
				else if (sstate.state === STREAM_OPENED) {
					// Restart the current stream
					wsep.emit('stream-restart', sstate, so_node.attrs);
				}
			}

			assert(nodes instanceof Array);

			// Process the nodes normally.
			wsep.emit('nodes', sstate, nodes);

			// TODO: Terminate if necessary

		});

		conn.on("close", function() {
			console.log('[*] close');
		});

	});
	
	websocket_server.on("disconnect", function(conn) {
		console.log("Disconnected");
		// Raise the terminate event on wsep
		wsep.emit('terminate', sstate);
		// uncomment: stat_stream_terminate();
		delete sn_state[stream_name];
	});

	// TODO: Handle the 'error' event on the bosh_server and re-emit it. 
	// Throw an exception if no one handles the exception we threw
};


exports.test = function() {
	var hs = http.createServer(function() {
		console.log("HTTP REQUEST");
	});

	hs.listen(8080);
	exports.createServer({ http_server: hs });
};

exports.test();
