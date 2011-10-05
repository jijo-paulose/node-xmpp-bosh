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

var helper = require('./helper.js');

function BOSH_Options(opts) {

    var _opts = opts;

    this._HTTP_GET_RESPONSE_HEADERS = {
		'Content-Type': 'application/xhtml+xml; charset=UTF-8',
		'Cache-Control': 'no-cache, no-store',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, x-requested-with, Set-Cookie',
		'Access-Control-Allow-Methods': 'OPTIONS, GET, POST',
		'Access-Control-Max-Age': '14400'
	};

    this._HTTP_POST_RESPONSE_HEADERS = {
		'Content-Type': 'text/xml; charset=UTF-8',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, x-requested-with, Set-Cookie',
		'Access-Control-Allow-Methods': 'OPTIONS, GET, POST',
		'Access-Control-Max-Age': '14400'
	};

    this._HTTP_OPTIONS_RESPONSE_HEADERS = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, x-requested-with, Set-Cookie',
		'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
		'Access-Control-Max-Age': '14400'
	};

    if (_opts.http_headers) {
		helper.add_to_headers(this._HTTP_GET_RESPONSE_HEADERS, _opts.http_headers);
		helper.add_to_headers(this._HTTP_POST_RESPONSE_HEADERS, _opts.http_headers);
		helper.add_to_headers(this._HTTP_OPTIONS_RESPONSE_HEADERS, _opts.http_headers);
	}

    this.__defineGetter__("path", function () {
        return _opts.path;
    });

	// The maximum number of bytes that the BOSH server will
	// "hold" from the client.
	this.__defineGetter__("MAX_DATA_HELD",  function () {
		return _opts.max_data_held || 100000;
	});

	// Don't entertain more than 2 (default) simultaneous connections
	// on any BOSH session.
	this.__defineGetter__("MAX_BOSH_CONNECTIONS", function () {
		return _opts.max_bosh_connections || 2;
	});

	// The maximum number of packets on either side of the current 'rid'
	// that we are willing to accept.
	this.__defineGetter__("WINDOW_SIZE", function () {
		return _opts.window_size || 2;
	});

	// How much time (in second) should we hold a response object
	// before sending and empty response on it?
	this.__defineGetter__("DEFAULT_INACTIVITY", function () {
		return _opts.default_inactivity || 70;
	});

	this.__defineGetter__("MAX_INACTIVITY", function () {
		return _opts.max_inactivity || 160;
	});

	this.__defineGetter__("HTTP_SOCKET_KEEPALIVE", function () {
		return _opts.http_socket_keepalive || 60;
	});

	this.__defineGetter__("MAX_STREAMS_PER_SESSION", function () {
		return _opts.max_streams_per_session || 8;
	});

    this.__defineGetter__("HTTP_GET_RESPONSE_HEADERS", function () {
		return this._HTTP_GET_RESPONSE_HEADERS;
	});

	this.__defineGetter__("HTTP_POST_RESPONSE_HEADERS", function () {
		return this._HTTP_POST_RESPONSE_HEADERS;
	});

	this.__defineGetter__("HTTP_OPTIONS_RESPONSE_HEADERS", function () {
		return this._HTTP_OPTIONS_RESPONSE_HEADERS;
	});
}

exports.BOSH_Options = BOSH_Options;