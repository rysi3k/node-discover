var dgram = require('dgram'),
    redis = require('./redis'),
    crypto = require('crypto'),
    os = require('os'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    uuid = require('uuid/v4'),
    nodeVersion = process.version.replace('v','').split(/\./gi).map(function (t) { return parseInt(t, 10) });

var procUuid = uuid();
var hostName = process.env.DISCOVERY_HOSTNAME || os.hostname();

module.exports = Network;

function Network (options) {
    if (!(this instanceof Network)) {
        return new Network(options, callback);
    }

    EventEmitter.call(this);

    var self = this, options = options || {};

    self.address        = options.address   || '0.0.0.0';
    self.port           = options.port      || 12345;
    self.broadcast      = options.broadcast || null;
    self.multicast      = options.multicast || null;
    self.multicastTTL   = options.multicastTTL || 1;
    self.unicast        = options.unicast   || null;
    self.key            = options.key ? Buffer.concat([Buffer.from(options.key), Buffer.alloc(32)], 32) : null;
    self.reuseAddr      = (options.reuseAddr === false) ? false : true;
    self.ignoreProcess  = (options.ignoreProcess ===  false) ? false : true;
    self.ignoreInstance = (options.ignoreInstance ===  false) ? false : true;
    self.redis          = options.redis;
    self.hostName       = options.hostname || options.hostName || hostName;
    self.helloCache = null;
    self.helloReceiveCache = {};
    if (self.redis) {
        self.socket = redis.createSocket(self.redis);
    }
    else if (nodeVersion[0] === 0 && nodeVersion[1] < 12) {
        //node v0.10 does not support passing an object to dgram.createSocket
        //not sure if v0.11 does, but assuming it does not.
        self.socket = dgram.createSocket('udp4');
    }
    else {
        self.socket = dgram.createSocket({type: 'udp4', reuseAddr: self.reuseAddr });
    }

    self.instanceUuid = uuid();
    self.processUuid = procUuid;

    self.socket.on("message", function ( data, rinfo ) {
        self.decode(data, function (err, obj) {
            if (err) {
                //most decode errors are because we tried
                //to decrypt a packet for which we do not
                //have the key

                //the only other possibility is that the
                //message was split across packet boundaries
                //and that is not handled

                //self.emit("error", err);
            }
            else if (obj.pid == procUuid && self.ignoreProcess && obj.iid !== self.instanceUuid) {
                    return false;
            }
            else if (obj.iid == self.instanceUuid && self.ignoreInstance) {
                    return false;
            }
            else if (obj.event && obj.data) {
                self.emit(obj.event, obj.data, obj, rinfo);
            }
            else {
                self.emit("message", obj)
            }
        }, rinfo);
    });

    self.on("error", function (err) {
        //TODO: Deal with this
        /*console.log("Network error: ", err.stack);*/
    });
};

util.inherits(Network, EventEmitter);

Network.prototype.start = function (callback) {
    var self = this;

    self.socket.bind(self.port, self.address, function () {
        if (self.unicast) {
            if (typeof self.unicast === 'string' && ~self.unicast.indexOf(',')) {
                self.unicast = self.unicast.split(',');
            }

            self.destination = [].concat(self.unicast);
        }
        else if (self.redis) {
            self.destination = [true];
        }
        else if (!self.multicast) {
            //Default to using broadcast if multicast address is not specified.
            self.socket.setBroadcast(true);

            //TODO: get the default broadcast address from os.networkInterfaces() (not currently returned)
            self.destination = [self.broadcast || "255.255.255.255"];
        }
        else {
            try {
                //addMembership can throw if there are no interfaces available
                self.socket.addMembership(self.multicast);
                self.socket.setMulticastTTL(self.multicastTTL);
            }
            catch (e) {
                self.emit('error', e);

                return callback && callback(e);
            }

            self.destination = [self.multicast];
        }

        return callback && callback();
    });
};

Network.prototype.stop = function (callback) {
    var self = this;

    self.socket.close();

    return callback && callback();
};

Network.prototype.send = function (event) {
    var self = this;

    var obj = {
        event : event,
        pid : procUuid,
        iid : self.instanceUuid,
        hostName : self.hostName
    };

    if (arguments.length == 2) {
        obj.data = arguments[1];
    }
    else {
        //TODO: splice the arguments array and remove the first element
        //setting data to the result array
    }

    self.encode(obj, function (err, contents) {
        if (err) {
            return false;
        }

        var msg = new Buffer(contents);

        self.destination.forEach(function (destination) {
            self.socket.send(
                msg
                , 0
                , msg.length
                , self.port
                , destination
            );
        });
    }, event);
};

Network.prototype.encode = function (data, callback, event) {
    var isHello = event === "hello";
    if (isHello && this.helloCache) {
        return callback(null, this.helloCache);
    }
    var self = this
        , tmp
        ;

    try {
        tmp = (self.key)
            ? encrypt(JSON.stringify(data),self.key)
            : JSON.stringify(data)
            ;
        if (isHello) {
            self.helloCache = tmp;
        }
    }
    catch (e) {
        return callback(e, null);
    }

    return callback(null, tmp);
};

Network.prototype.decode = function (data, callback, rinfo) {
    var self = this
        , tmp
        ;
    var cacheKey = rinfo.address + ":" + rinfo.port;
    var cached = self.helloReceiveCache[cacheKey];
    data = data.toString();
    if (cached) {
        for (var i = 0; i < cached.length; i++) {
            if (cached[i]['data'] === data) {
                return callback(null, cached[i]['decoded']);
            }
        }
    }
    try {
        if (self.key) {
            tmp = JSON.parse(decrypt(data,self.key));
        }
        else {
            tmp = JSON.parse(data);
        }
        if (tmp && tmp.event === "hello") {
            self.helloReceiveCache[cacheKey] = (self.helloReceiveCache[cacheKey] || []).filter(function (cache) {
                return cache['decoded'].iid !== tmp.iid;
            });
            self.helloReceiveCache[cacheKey].push({data: data, decoded: tmp});
        }
    }
    catch (e) {
        return callback(e, null);
    }

    return callback(null, tmp);
};

const algorithm = 'aes-256-ctr';
const IV_LENGTH = 16;
const iv = crypto.randomBytes(IV_LENGTH);

function encrypt(text, key) {
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text, key) {
    const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(text.slice(0, IV_LENGTH * 2), 'hex'));
    let decrypted = decipher.update(Buffer.from(text.slice(IV_LENGTH * 2 + 1), 'hex'));
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}
