var RPC = require('socket.io-rpc-client');
var extend = Object.copyOwnProperties;	//this is defined in o.extend dependency to socket.io-rpc
var debug = require('debug')('moonridge:client');
var QueryChainable = require('./moonridge/query-chainable');
var difference = require('lodash.difference');
var isNumber = function(val) {
	return typeof val === 'number';
};

/**
 * A Moonridge pseudo-constructor(don't call it with new keyword)
 * @param {Object} opts an object with following properties:
 *                                  {String} url backend address where you will connect
 *                                  {Object} hs handshake for socket.io which you can access via socket.request._query
 * @returns {Moonridge} a Moonridge backend instance
 */
function Moonridge(opts) {

	var defUser = {privilige_level: 0};
	var self = {user: defUser}; //by default, users priviliges are always set to 1

	var models = Object.create(null);

	self.rpc = RPC(opts.url, opts.hs);
	self.socket = self.rpc.socket;
	self.getAllModels = function() {
		self.rpc('MR.getModels')().then(function(models) {
//                    TODO call getModel for all models
		});
	};

	self.authorize = function() {
		var pr = self.rpc('MR.authorize').apply(this, arguments);
		return pr.then(function(user) {
			self.user = user;
			return user;
		});
	};

	/**
	 * @param {String} name
	 * @constructor
	 */
	function Model(name) {
		var model = this;
		var lastIndex = 0;  //this is used for storing liveQueries in _LQs object as an index, each liveQuery has unique
		this.name = name;
		/**
		 * @param {String} modelMethod
		 * @returns {Promise}
		 */
		var modelRpc = function(modelMethod) {
			return self.rpc('MR.' + name + '.' + modelMethod);
		};
		this._LQs = {};	// holds all liveQueries on client indexed by numbers starting from 1, used for communicating with the server
		this._LQsByQuery = {};	// holds all liveQueries on client indexed query in json, used for checking if the query does not exist already

		/**
		 * @param {Object} toSave moonridge object
		 * @returns {Promise} resolved when object is saved
		 */
		this.save = function(toSave) {
			return modelRpc('save')(toSave);
		};
		/**
		 * NOTE that you cannot pass update options(as in http://mongoosejs.com/docs/api.html#model_Model.update)
		 * 			it doesn't make sense to allow edit multiple docs with one command
		 * @param {Object} query which will be sent to mongo update call
		 * @param {Object} expression which will be sent to mongo update call
		 * @returns {Promise} resolved when object is updated
		 */
		this.update = function(query, expression) {
			return modelRpc('update')(query, expression);
		};

		/**
		 * @param {Object} toCreate
		 * @returns {Promise} resolved when object is created
		 */
		this.create = function(toCreate) {
			return modelRpc('create')(toCreate);
		};

		/**
		 * @param {Object} toRemove must have and _id
		 * @returns {Promise}
		 */
		this.remove = function(toRemove) {
			return modelRpc('remove')(toRemove._id);
		};

		/**
		 * @returns {Array<String>} indicating which properties this model has defined in it's schema
		 */
		this.listPaths = function() {
			return modelRpc('listPaths')();
		};

		/**
		 * @returns {QueryChainable} which has same methods as mongoose.js query. When you chain all query
		 *                           conditions, you use exec() to fire the query
		 */
		this.query = function() {
			var query = {query: [], indexedByMethods: {}};
			return new QueryChainable(query, function() {
				var callQuery = function() {
					query.promise = modelRpc('query')(query.query).then(function(result) {
						debug('query result ', result);
						query.result = result;
						if (query.indexedByMethods.findOne) {
							query.doc = result;
						} else if (query.indexedByMethods.distinct) {
							query.values = result;
						} else if (query.indexedByMethods.count) {
							query.count = result;
						} else {
							query.docs = result;
						}
						return result;
					});
				};

				query.exec = callQuery;
				callQuery();

				return query;
			}, model);
		};

		var createLQEventHandler = function(eventName) {
			return function(LQId, doc, isInResult) {
				var LQ = model._LQs[LQId];
				if (LQ) {
					var params = arguments;
					return LQ.promise.then(function() {
						LQ['on_' + eventName](doc, isInResult);
						LQ._invokeListeners(eventName, params);  //invoking model event
					});
				} else {
					debug('Unknown liveQuery calls this clients pub method, LQ id: ' + LQId);
				}
			}
		};

		var clientRPCMethods = ['distinctSync', 'update', 'remove', 'add'];
		this.clientRPCMethods = {};

		clientRPCMethods.forEach(function (name){
			this.clientRPCMethods[name] = createLQEventHandler(name);
		}.bind(this));

		/**
		 * @param {Object} previousLQ useful when we want to modify a running LQ, pass it after it is stopped
		 * @returns {QueryChainable} same as query, difference is that executing this QueryChainable won't return
		 *                           promise, but liveQuery object itself
		 */
		this.liveQuery = function(previousLQ) {

			previousLQ && previousLQ.stop();

			var LQ = {_model: model, docs: [], count: 0};

			if (typeof Object.defineProperty === 'function') {
				Object.defineProperty(LQ, 'doc', {
					enumerable: false,
					configurable: false,
					get: function() {
						return LQ.docs[0];
					}
				});
			}

			var eventListeners = {
				update: [],
				distinctSync: [],
				remove: [],
				add: [],
				init: [],    //is fired when first query result gets back from the server
				any: []
			};

			LQ._invokeListeners = function() {
				var which = arguments[0];
				debug('invoking ', which, ' with arguments ', arguments);
				var index = eventListeners[which].length;
				while (index--) {
					try{
						eventListeners[which][index].apply(LQ, arguments);
					}catch(err){
						console.error(err.stack);
						throw err;
					}
				}

				index = eventListeners.any.length;
				while (index--) {
					try{
						eventListeners.any[index].apply(LQ, arguments);
					}catch(err){
						console.error(err.stack);
						throw err;
					}
				}
			};

			/**
			 * registers event callback on this model
			 * @param {String} evName
			 * @param {Function} callback will be called with LiveQuery as context, evName, and two other params
			 * @returns {Number}
			 */
			LQ.on = function(evName, callback) {
				var subscriberId = eventListeners[evName].push(callback) - 1;
				/**
				 * unregisters previously registered event callback
				 * @returns {Boolean} true when event was unregistered, false any subsequent call
				 */
				return function unsubscribeEventListener() {
					if (eventListeners[evName][subscriberId]) {
						eventListeners[evName].splice(subscriberId, 1);
						return true;
					} else {
						return false;
					}
				};
			};

			if (typeof previousLQ === 'object') {
				LQ.query = previousLQ.query;
				LQ.indexedByMethods = previousLQ.indexedByMethods;
			} else {
				LQ.query = [];  //serializable query object
				// utility object to which helps when we need to resolve query type and branch our code
				LQ.indexedByMethods = {};
			}

			LQ.getDocById = function(id) {
				var i = LQ.docs.length;
				while (i--) {
					if (LQ.docs[i]._id === id) {
						return LQ.docs[i];
					}
				}
				return null;
			};
			LQ.recountIfNormalQuery = function() {
				if (!LQ.indexedByMethods.count) {
					LQ.count = LQ.docs.length;
				}
			};
			//syncing logic
			LQ.on_add = function(doc, index) {

					if (LQ.indexedByMethods.findOne) {
						return LQ.docs.splice(index, 1, doc);
					}
					if (LQ.indexedByMethods.count) {
						LQ.count += 1; // when this is a count query, just increment and call it a day
						return;
					}

					if (LQ.docs[index]) {
						LQ.docs.splice(index, 0, doc);
					} else {
						LQ.docs.push(doc);
					}
					if (LQ.indexedByMethods.limit < LQ.docs.length) {
						LQ.docs.splice(LQ.docs.length - 1, 1);  // this needs to occur after push of the new doc
					}
					LQ.recountIfNormalQuery();

			};
			/**
			 *
			 * @param {Object} doc
			 * @param {Number} resultIndex for count it indicates whether to increment, decrement or leave as is,
			 *                   for normal queries can be a numerical index also
			 */
			LQ.on_update = function(doc, resultIndex) {
				debug('LQ.on_update ', doc, resultIndex);

					if (LQ.indexedByMethods.count) {	// when this is a count query
						if (resultIndex === -1) {
							LQ.count -= 1;
						} else {
							LQ.count += 1;
						}
						return;// just increment/decrement and call it a day
					}

					var i = LQ.docs.length;
					while (i--) {
						var updated;
						if (LQ.docs[i]._id === doc._id) {
							if (resultIndex === false) {
								LQ.docs.splice(i, 1);  //removing from docs
								return;
							} else {
								// if a number, then doc should be moved

								if (resultIndex !== i) {
									LQ.docs.splice(i, 1);
									if (i < resultIndex) {
										LQ.docs.splice(resultIndex - 1, 0, doc);
									} else {
										LQ.docs.splice(resultIndex, 0, doc);
									}

								} else {
									updated = LQ.docs[i];
									extend(updated, doc);
								}

							}

							return;
						}
					}
					//when not found
					if (resultIndex !== -1) {
						if (LQ.docs[resultIndex]) {
							LQ.docs.splice(resultIndex, 0, doc);
						} else {
							LQ.docs.push(doc); // pushing into docs if it was not found by loop
						}
						return;
					}
					debug('Failed to find updated document _id ' + doc._id);
					LQ.recountIfNormalQuery();

			};
			/**
			 * @param {String} id
			 * @returns {boolean} true when it removes an element
			 */
			LQ.on_remove = function(id) {

					if (LQ.indexedByMethods.count) {
						LQ.count -= 1;	// when this is a count query, just decrement and call it a day
						return true;
					}
					var i = LQ.docs.length;
					while (i--) {
						if (LQ.docs[i]._id === id) {
							LQ.docs.splice(i, 1);
							LQ.count -= 1;
							return true;
						}
					}
					debug('Failed to find deleted document.');

					return false;

			};
			LQ.on_distinctSync = function(syncObj) {
				debug('distinctSync has run, values now ', LQ.values);

				LQ.values = LQ.values.concat(syncObj.add);
				LQ.values = difference(LQ.values, syncObj.remove);

				debug('distinctSync has run, values now ', LQ.values);

			};
			/**
			 * notify the server we don't want to receive any more updates on this query
			 * @returns {Promise}
			 */
			LQ.stop = function() {
				debug('stopping live query: ', LQ.index);
				if (isNumber(LQ.index) && model._LQs[LQ.index]) {
					LQ.stopped = true;
					return modelRpc('unsubLQ')(LQ.index).then(function() {

						delete model._LQs[LQ.index];
						delete model._LQsByQuery[LQ._queryStringified];

					});

				} else {
					throw new Error('There must be a valid index property, when stop is called')
				}
			};

			/**
			 * @param {Boolean} dontSubscribe when true, no events from socket will be subscribed
			 * @returns {Object} live query object with docs property which contains realtime result of the query
			 */
			var queryExecFn = function(dontSubscribe) {
				if (!LQ._queryStringified) {
					if (LQ.indexedByMethods.hasOwnProperty('count') && LQ.indexedByMethods.hasOwnProperty('sort')) {
						throw new Error('count and sort must NOT be used on the same query');
					}
					LQ._queryStringified = JSON.stringify(LQ.query);
					if (model._LQsByQuery[LQ._queryStringified] && model._LQsByQuery[LQ._queryStringified].stopped !== true) {
						return model._LQsByQuery[LQ._queryStringified];
					}

					//if previous check did not found an existing query
					model._LQsByQuery[LQ._queryStringified] = LQ;

					lastIndex += 1;

					model._LQs[lastIndex] = LQ;
					LQ.index = lastIndex;

				}

				LQ.promise = modelRpc('liveQuery')(LQ.query, LQ.index).then(function(res) {

					if (LQ.indexedByMethods.count) {  // this is a count query when servers sends number
						debug('Count we got back from the server is ' + res.count);

						// this is not assignment but addition on purpose-if we create/remove docs before the initial
						// count is determined we keep count of them inside count property. This way we stay in sync
						// with the real count
						LQ.count += res.count;

					} else if (LQ.indexedByMethods.distinct) {
						LQ.values = res.values;
					} else {

						var i = res.docs.length;
						LQ.count += i;

						while (i--) {
							LQ.docs[i] = res.docs[i];
						}

					}
					LQ._invokeListeners('init', res);

					if (!dontSubscribe) {
						self.socket.on('disconnect', function() {
							LQ.stopped = true;
						});

						var reExecute = function() {

							LQ.docs = [];
							LQ.count = 0;

							queryExecFn(true);

						};
						if (self.authObj) { //auth obj should be deleted if you need to logout a user
							//when user is authenticated, we want to reexecute after he is reauthenticated
							self.socket.on('authSuccess', reExecute);
						} else {
							//when he is anonymous, reexecute right after reconnect
							self.socket.on('reconnect', reExecute);
						}
					} else {
						LQ.stopped = false;
						LQ.live = true;
					}

					return LQ;	//
				});

				return LQ;
			};

			return new QueryChainable(LQ, queryExecFn, model);
		}
	}

	/**
	 * loads one model or returns already requested model promise
	 * @param {String} name
	 * @returns {Promise} which resolves with the model
	 */
	self.model = function(name) {
		var model = models[name];
		if (!model) {
			model = new Model(name);
			models[name] = model;

			var toExpose = {};
			toExpose[name] = model.clientRPCMethods;
			self.rpc.expose({MR: toExpose});
		}

		return model;
	};

	/**
	 * loads more than one model
	 * @param {Array<string>} models
	 * @returns {Promise} which resolves with an Object where models are indexed by their names
	 */
	self.getModels = function(models) {
		var promises = {};
		var index = models.length;
		while (index--) {
			var modelName = models[index];
			promises[modelName] = self.getModel(modelName);
		}
		return Promise.all(promises);
	};

	return self;
}


module.exports = Moonridge;