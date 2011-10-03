var helper = require('./helper.js');

function BOSH_Options(opts) {
	this._opts = opts;
	
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
	}
	

	if (this._opts.http_headers) {
		helper.add_to_headers(this._HTTP_GET_RESPONSE_HEADERS, this._opts.http_headers);
		helper.add_to_headers(this._HTTP_POST_RESPONSE_HEADERS, this._opts.http_headers);
		helper.add_to_headers(this._HTTP_OPTIONS_RESPONSE_HEADERS, this._opts.http_headers);
	}	
}

BOSH_Options.prototype = {
	
	path: function() {
		return this._opts.path;
	},
	
	// The maximum number of bytes that the BOSH server will 
	// "hold" from the client.
	MAX_DATA_HELD: function() {
		return this._opts.max_data_held || 100000;
	},
	
	// Don't entertain more than 2 (default) simultaneous connections 
	// on any BOSH session.
	MAX_BOSH_CONNECTIONS: function() {
		return this._opts.max_bosh_connections || 2;
	},
		
	// The maximum number of packets on either side of the current 'rid'
	// that we are willing to accept.
	WINDOW_SIZE: function() {
		return this._opts.window_size || 2;
	},

	// How much time (in second) should we hold a response object 
	// before sending and empty response on it?
	DEFAULT_INACTIVITY: function() {
		return this._opts.default_inactivity || 70;
	},

	MAX_INACTIVITY: function() {
		return this._opts.max_inactivity || 160;
	},

	HTTP_SOCKET_KEEPALIVE: function() {
		return this._opts.http_socket_keepalive || 60;
	},

	MAX_STREAMS_PER_SESSION: function() {
		return this._opts.max_streams_per_session || 8;
	},
	
	HTTP_GET_RESPONSE_HEADERS: function() {
		return this._HTTP_GET_RESPONSE_HEADERS;
	},

	HTTP_POST_RESPONSE_HEADERS: function() {
		return this._HTTP_POST_RESPONSE_HEADERS;
	},

	HTTP_OPTIONS_RESPONSE_HEADERS: function() {
		return this._HTTP_OPTIONS_RESPONSE_HEADERS;
	}

};

exports.BOSH_Options = BOSH_Options;