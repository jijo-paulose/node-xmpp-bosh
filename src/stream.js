var dutil		= require('./dutil.js');
var uuid		= require('node-uuid');
var helper  	= require('./helper.js');
var us     		= require('underscore');
var response	= require('./response.js');

function Streams(bosh_options, bep) {	
	
	this._bosh_options = bosh_options;	
	this._bep = bep;
	
	// This encapsulates the state for the client (xmpp) stream
	//
	// The same but by stream name.
	// Format: {
	//   stream_name: {
	//     name: "Stream Name", 
	//     to: "domain.tld", 
	//     terminated: true/false, 
	//     state: The sid_state object (as above)
	//     from (optional): The JID of the user for this stream
	//     route (optional): The endpoint of the server to connect to (xmpp:domain:port)
	//   }
	// }
	//
	this._sn_state = {
	};

	this._sn_info = {
		length	: 	0,	// Stores the number of active streams
		total	: 	0	// Stores the total number of streams
	};
	
	// This keeps in memory the terminate condition for a terminated stream. Both 
	// this, and terminated_sessions are used when the connection between nxb and 
	// xmpp server breaks and all the session related info is wiped out. We 
	// preserve the condition in this case to let the client know why was its 
	// connection broken.
	this._terminated_streams = {
	};	
}

Streams.prototype = {
	
	get_active_no: function(){
		return this._sn_info.length;
	},
	
	get_total_no: function(){
		return this._sn_info.total;
	},
	
	//Fetches a BOSH stream object given a BOSH stanza (<body> tag)
	//A node may not contain a stream name if it is the only stream in the session
	get_stream: function(node) {
		var sname = this.get_name(node); 
		var stream = sname ? this._sn_state[sname] : null;
		return stream;		
	},
	
	get_name: function(node) {
		return node.attrs.stream;
	},
	
	get_streams_obj: function() {
		return this._sn_state;
	},
	
	// Coded according to the rules mentioned here:
	// http://xmpp.org/extensions/xep-0206.html#create and
	// http://xmpp.org/extensions/xep-0206.html#preconditions-sasl
	is_stream_restart_packet: function(node) {
		var ia = dutil.inflated_attrs(node);
		return ia['urn:xmpp:xbosh:restart'] === 'true';
	},

	// Coded according to the rules mentioned here:
	// http://xmpp.org/extensions/xep-0124.html#multi-add
	is_stream_add_request: function(node) {
		return node.attrs.to && 
			node.attrs.sid && 
			node.attrs.rid && 
			!node.attrs.ver && !node.attrs.hold && !node.attrs.wait;
	},

	// Coded according to the rules mentioned here:
	// http://xmpp.org/extensions/xep-0124.html#terminate
	is_stream_terminate_request: function(node) {
		return node.attrs.sid && 
			node.attrs.rid && 
			node.attrs.type === 'terminate';
	},
			
	// These functions don't communicate with either the Client
	// or the Connector. That is someone else's job. They just
	// update internal state for the operations being performed.
	add_stream: function (session, node) {		
		var self = this;
		var stream = new Stream(session, node, this._bosh_options, this._bep, 
			function(stream, condition) {
				helper.save_terminate_condition_for_wait_time(self._terminated_streams,
					stream.NAME(), condition, stream._session.wait());		
				delete self._sn_state[stream.NAME()];
				self.stat_stream_terminate();  		
			});
		session.add_stream(stream);			
		this._sn_state[stream.NAME()] = stream;
		this.stat_stream_add();		
		// Don't yet respond to the client. Wait for the 'stream-added' event
		// from the Connector.		
		this._bep.emit('stream-add', stream.get_api_state());
		return stream;
	},
	
	send_session_terminate_invalid_stream_response: function(res, sname) {
		var terminate_condition;
		if (this._terminated_streams[sname]) {
			terminated_condition = this._terminated_streams[sname].condition;
		}
		var attrs = {
			condition: terminate_condition || 'item-not-found', 
			message: terminate_condition ? '' : 'Invalid stream name', 
			stream: sname
		}
		ro = new response.Response(res, null);
		ro.send_termination_stanza(attrs);						
	},
	
	stat_stream_add: function() {
		++this._sn_info.length;
		++this._sn_info.total;
	},	
	
	stat_stream_terminate: function() {
		--this._sn_info.length;
	}
}

function Stream(session, node, options, bep, call_on_terminate) {
	this._on_terminate 	= call_on_terminate;	
	this._options		= options;
	this._bep			= bep;
	this._name			= uuid();
	this._terminated	= false, 
	this._to			= node.attrs.to, 
	this._session		= session
	// Routes are specific to a stream, and not a session
	if (node.attrs.route) {
		this._route = helper.route_parse(node.attrs.route);
	}
	if (node.attrs.from) {
		this._from = node.attrs.from;
	}
}

Stream.prototype = {	
	NAME: function() {
		return this._name;
	},
	
	to: function() {
		return this._to;
	},
	
	from: function() {
		return this._from;
	},
	
	terminate: function(condition) {
		this._session.delete_stream(this);
		this._on_terminate(this, condition);
	},
	
	// Terminates an open stream.
	// condition: (optional) A string which specifies the condition to 
	//     send to the client as to why the stream was closed.
	send_stream_terminate_response: function(condition) {
		var session = this._session;
		var attrs = {
			stream: this._name
		};
		if (condition) {
			// Set the condition so that listeners may be able to 
			// determine why this stream was terminated
			this._condition = condition;
			attrs.condition  = condition;
		}

		var msg = helper.$terminate(attrs);
		session.enqueue_response(msg, this);

		// Mark the stream as terminated AFTER the terminate response has been queued.
		this._terminated = true;
	},
	
	handle_restart: function(node){
		if (node.attrs.stream_attrs) {
			this._attrs = dutil.json_parse(node.attrs.stream_attrs, { });
		}
		this._bep.emit('stream-restart', this.get_api_state()); 
	},
	
	// returns an API compatible state. 
	get_api_state: function(){ 
		var self = this;
		var sstate = {
			name		: self._name, 
			terminated	: self._terminated, 
			to			: self._to, 
			state		: self._session.get_api_state(),
			stream		: self
		};
		if (self._route) {
			sstate.route = self._route;
		}
		if (self._from) {
			sstate.from = self._from;
		}
		return sstate;	
	},
	
	send_stream_add_response: function() {
		var session = this._session;
		var attrs = {
			stream:     this._name, 
			from:       this._to
		};

		if (this._from) {
			// This is *probably* the JID of the user. Send it back as 'to'. 
			// This isn't mentioned in the spec.
			attrs.to = this._from;
		}
		var response = helper.$body(attrs);
		session.enqueue_response(response, this);
	}
}

exports.Streams = Streams;
//exports.stream = Stream;