var us     		= require('underscore');
var dutil  		= require('./dutil.js');
var helper  	= require('./helper.js');
var log_it   	= dutil.log_it;
var NULL_FUNC	= dutil.NULL_FUNC;


function Response(res, request_id, options) {	
	this._res		= res;
	this._rid		= request_id;	
	this._options 	= options;	
}

Response.prototype = { 	
	
	RID: function() {
		return this._rid;
	},
	
	set_timeout: function(func, wait) {
		this._timeout = setTimeout(func, wait);
	},
	
	clear_timeout: function() {
		clearTimeout(this._timeout);		
	},
	
	set_error: function(error_func) {
		this._res.on('error', error_func);
	},
	
	send_empty_body: function () {
		this.send_response(helper.$body().toString())
	},
	
	// Sends a stream termination response on an HTTP response (res) object.
	// This method is generally used to terminate rogue connections.
	send_termination_stanza: function (attrs) {
		attrs = attrs || { };
		this.send_response(helper.$terminate(attrs).toString(), true);
	},
	
	// Allow Cross-Domain access
	// https://developer.mozilla.org/En/HTTP_access_control
	send_response: function(msg, dont_set_error_null) {
		// To prevent an unhandled exception later
		if (!dont_set_error_null)	
			this._res.on('error', NULL_FUNC);
		this._res.writeHead(200, this._options.HTTP_POST_RESPONSE_HEADERS());
		this._res.end(msg);		
	},
		
	// If a client closes a connection and a response to that HTTP request 
	// has not yet been sent, then the 'error' event is NOT raised by node.js.
	// Hence, we need not attach an 'error' event handler yet.

	// res.socket could be undefined if this request's socket is still in the 
	// process of sending the previous request's response. Either ways, we 
	// can be sure that setTimeout and setKeepAlive have already been called 
	// on this socket.
	set_socket_options: function(wait) {
		if (this._res.socket) {
			// Increasing the timeout of the underlying socket to allow 
			// wait > 120 sec
			this._res.socket.setTimeout(wait * 1000 + 10);
			this._res.socket.setKeepAlive(true, this._options.HTTP_SOCKET_KEEPALIVE());
		}		
	}
}


exports.Response = Response;
