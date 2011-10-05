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

var http        = require('http');
var url         = require('url');
var EventPipe   = require('eventpipe').EventPipe;
var helper      = require('./helper.js');
var dutil       = require('./dutil.js');
var util        = require('util');
var us          = require('underscore');

var sprintf     = dutil.sprintf;
var sprintfd    = dutil.sprintfd;
var log_it      = dutil.log_it;


function BoshEventPipe(host, port, bosh_options, error_handler, bosh_request_processor, stat_func) {

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
		log_it("DEBUG", sprintfd("BEE::Processing request: %s", node));
		bosh_request_processor(res, node);
	}

	// All request handlers return 'false' on successful handling
	// of the request and 'undefined' if they did NOT handle the
	// request. This is according to the EventPipe listeners API
	// expectation.    
    function handle_get_bosh_request(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method === 'GET' && ppos !== -1 && u.query.hasOwnProperty('data')) {
            res = new helper.JSONPResponseProxy(req, res);
            bosh_request_handler(res, u.query.data || '');
            return false;
        }
    }

    function handle_post_bosh_request(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method !== 'POST' || ppos === -1) {
            return;
        }
        var data = [];
        var data_len = 0;

        var end_timeout;
        var _on_end_callback = us.once(function (timed_out) {
            if (timed_out) {
                log_it("WARN", "BEE::Timing out (and destroying) connection from '" +
                    req.socket.remoteAddress + "'");
                req.destroy();
            } else {
                bosh_request_handler(res, data.join(''));
                clearTimeout(end_timeout);
            }
        });

        // Timeout the request of we don't get an 'end' event within
        // 20 sec of the request being made.
        end_timeout = setTimeout(function () {
            _on_end_callback(true);
        }, 20 * 1000);


        req.on('data', function (d) {
            var _d = d.toString();
            data_len += _d.length;
            // Prevent attacks. If data (in its entirety) gets too big,
            // terminate the connection.
            if (data_len > bosh_options.MAX_DATA_HELD) {
                // Terminate the connection. We null out 'data' to aid GC
                data = null;
                _on_end_callback(true);
                return;
            }
            data.push(_d);
        })

            .on('end', function () {
                _on_end_callback(false);
            })

            .on('error', function (ex) {
                log_it("WARN", "BEE::Exception '" + ex.toString() + "' while processing request");
                log_it("WARN", "BEE::Stack Trace:\n", ex.stack);
            });
        return false;
    }

	function handle_options(req, res, u) {
		if (req.method === 'OPTIONS') {
			res.writeHead(200, bosh_options.HTTP_OPTIONS_RESPONSE_HEADERS);
			res.end();
			return false;
		}
	}

    function handle_get_favicon(req, res, u) {
        if (req.method === 'GET' && u.pathname === '/favicon.ico') {
            res.writeHead(303, {
                'Location': 'http://xmpp.org/favicon.ico'
            });
            res.end();
            return false;
        }
    }

    function handle_get_statistics(req, res, u) {
        var ppos = u.pathname.search(bosh_options.path);
        if (req.method === 'GET' && ppos !== -1 && !u.query.hasOwnProperty('data')) {
            res.writeHead(200, bosh_options.HTTP_GET_RESPONSE_HEADERS);
            var stats = stat_func();
            res.end(stats);
            return false;
        }
    }

    function handle_unhandled_request(req, res, u) {
        log_it("ERROR", "BEE::Invalid request, method:", req.method, "path:",
            u.pathname);
        var _headers = { };
        dutil.copy(_headers, bosh_options.HTTP_POST_RESPONSE_HEADERS);
        _headers['Content-Type'] = 'text/plain; charset=utf-8';
        res.writeHead(404, _headers);
        res.end();
        return false;
    }

    var router = new EventPipe();
    router.on('request', handle_post_bosh_request, 1)
        .on('request', handle_get_bosh_request, 2)
        .on('request', handle_options, 3)
        .on('request', handle_get_favicon, 4)
        .on('request', handle_get_statistics, 5)
        .on('request', handle_unhandled_request, 6);

    function http_request_handler(req, res) {
        var u = url.parse(req.url, true);
        log_it("DEBUG", sprintfd("BEE::Processing '%s' request at location: %s",
            req.method, u.pathname));
        router.emit('request', req, res, u);
    }

	this.server = http.createServer(http_request_handler);
	this.server.on('error', error_handler);
	this.server.listen(port, host);
}

util.inherits(BoshEventPipe, EventPipe);

dutil.copy(BoshEventPipe.prototype, {
	stop: function () {
		return this.server.close();
	},

	set_session_data: function (sessions) {
		this.sid_state = sessions.get_sessions_obj();
	},

	set_stream_data: function (streams) {
		this.sn_state = streams.get_streams_obj();
		this.stat_stream_add = streams.stat_stream_add;
		this.stat_stream_terminate = streams.stat_stream_terminate;
	}
});

exports.BoshEventPipe = BoshEventPipe;
