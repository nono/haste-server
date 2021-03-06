//jshint node: true, strict: false
/*eslint strict:0 */
//jscs:disable
var fs              = require('fs'),
    winston         = require('winston'),
    connect         = require('connect'),
    uglify          = require('uglify-js'),
    connectRoute    = require('connect-route'),
    st              = require('st'),
    DocumentHandler = require('./lib/document_handler'),
    IrcHandler      = require('./lib/irchandler'),
    Settings        = require('./lib/settings'),
    config, settings, settingsStore, Store, preferredStore;

// Load the configuration and set some defaults
config = JSON.parse(fs.readFileSync('./config.js', 'utf8'));
config.port = process.env.PORT || config.port || 7777;
config.host = process.env.HOST || config.host || 'localhost';

function generatePassword() {
  var pass = '';
  while (pass.length < 32) {
    pass += Math.random().toString(36).slice(-8);
  }
  return pass;
}
function updatePass(cb) {
  "use strict";
  settings.curlPassword = generatePassword();
  settingsStore.set(settings, function (err, res) {
    if (err) {
      winston.error(err);
    } else {
      settings = res;
    }
    if (typeof cb === 'function') {
      cb(settings);
    }
  });
}

// Set up the logger
if (config.logging) {
  try {
    winston.remove(winston.transports.Console);
  } catch (er) { }
  config.logging.forEach(function (detail) {
    winston.add(winston.transports[detail.type], {level: detail.level, colorize: detail.colorize});
  });
}

// Init settings
settings = {
  curlPassword:  generatePassword()
};
settingsStore = new Settings();
settingsStore.get(function (err, res) {
  if (err) {
    winston.error(err);
  } else {
    if (res.length === 0) {
      // Create settings
      updatePass();
    } else {
      settings = res[0];
    }
  }
});

// build the store from the config on-demand - so that we don't load it for statics
if (!config.storage) {
  config.storage = { type: 'redis' };
}
if (!config.storage.type) {
  config.storage.type = 'redis';
}

Store = require('./lib/document_stores/' + config.storage.type);
preferredStore = new Store(config.storage);

// Pick up a key generator
var pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || 'keygen';
var gen = require('./lib/key_generators/' + pwOptions.type);
var keyGenerator = new gen(pwOptions);

var ircHandler;
if (config.irc) {
  config.irc.log = {
    info: function(){},
    warn: function(line) {
      winston.warn('irc: ' + line);
    },
    error: function(line) {
      winston.error('irc: ' + line);
    }
  };
  ircHandler = new IrcHandler(preferredStore, config.irc);
}

// Configure the document handler
var documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  var list = fs.readdirSync('./static');
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if ((item.indexOf('.js') === item.length - 3) && (item.indexOf('.min.js') === -1)) {
      var dest = item.substring(0, item.length - 3) + '.min' + item.substring(item.length - 3);
      var minified = uglify.minify('./static/' + item);
      fs.writeFileSync('./static/' + dest, minified.code, 'utf8');
      winston.info('compressed ' + item + ' into ' + dest);
    }
  }
}

// Send the static documents into the preferred store, skipping expirations
var path, data;
Object.keys(config.documents).forEach(function (name) {
  path = config.documents[name];

  var storeStaticDoc = function() {
    data = fs.readFileSync(path, 'utf8');
    if (data) {
      var syntax = '';
      var extIndex = path.lastIndexOf('.');
      if (extIndex > -1 && extIndex < path.length - 1) {
        syntax = path.substring(extIndex + 1);
      }
      var doc = {
        name: name,
        size: data.length,
        mimetype: 'text/plain',
        syntax: syntax
      };
      // we're not actually using http requests to initialize the static docs
      // so use a fake response object to determine finished success/failure
      var nonHttpResponse = {
        writeHead: function(code, misc) {
          if (code === 200) {
            winston.debug('loaded static document', { file: name, path: path });
          } else {
            winston.warn('failed to store static document', { file: name, path: path });
          }
        },
        end: function(){}
      };
      documentHandler._setStoreObject(doc, data, nonHttpResponse, true);
    }
    else {
      winston.warn('failed to load static document', { name: name, path: path });
    }
  };

  documentHandler._getStoreObject(name, true, {writeHead: function(){}, end: function(){}}, function(err, doc) {
    if (err) {
      storeStaticDoc();
    }
    else {
      winston.verbose('not storing static document as it already exists', {name: name});
    }
  });
});

var staticServe = st({
  path: './static',
  url: '/',
  index: 'index.html',
  passthrough: true
});

var apiServe = connectRoute(function(router) {
  // add documents
  router.post('docs', function(request, response, next) {
    return documentHandler.handlePost(request, response);
  });
  // add document from public url with basic auth
  router.post('public/docs', function(request, response, next) {
    var auth, credentials;
    function forbid() {
      response.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="example"'
      });
      response.end();
    }
    auth = request.headers.authorization;
    if (auth) {
      credentials = new Buffer(auth.split(' ')[1], 'base64').toString().split(':');

      if ((credentials[0] === 'haste') && (credentials[1] === settings.curlPassword)) {
        return documentHandler.handlePost(request, response);
      } else {
        forbid();
      }
    } else {
      forbid();
    }
  });
  // get documents
  router.get('docs/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    return documentHandler.handleGet(request, response, skipExpire);
  });
  // get document metadata
  router.head('docs/:id', function(request, response, next) {
    return documentHandler.handleHead(request, response);
  });
  // delete document
  router.delete('docs/:id', function(request, response, next) {
    return documentHandler.handleDelete(request, response);
  });
  // public URL to get documents
  router.get('public/:id', function(request, response, next) {
    var skipExpire = !!config.documents[request.params.id];
    return documentHandler.handleGet(request, response, skipExpire, true);
  });
  // public URL to get document metadata
  router.head('public/:id', function(request, response, next) {
    return documentHandler.handleHead(request, response, true);
  });
  // get recent documents
  router.get('recent', function(request, response, next) {
    return documentHandler.handleRecent(request, response);
  });
  // get metadata for keys
  router.get('keys/:keys', function(request, response, next) {
    return documentHandler.handleKeys(request, response);
  });
  // notify IRC of document
  router.get('irc/privmsg/:chan/:id', function(request, response, next) {
    if (ircHandler) {
      return ircHandler.handleNotify(request, response);
    }
  });
  router.get('pass', function(request, response, next) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ password: settings.curlPassword }));
  });
  router.post('pass', function(request, response, next) {
    updatePass(function (res) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ password: res.curlPassword }));
    });
  });
  // if the previous static-serving module didn't respond to the resource,
  // forward to next with index.html and the web client application will request the doc based on the url
  router.get(':id', function(request, response, next) {
    // redirect to index.html, also clearing the previous 'st' module 'sturl' field generated
    // by the first staticServe module. if sturl isn't cleared out then this new request.url is not
    // looked at again.
    request.url = '/index.html';
    request.sturl = null;
    next();
  });
});

var staticRemains = st({
  path: './static',
  url: '/',
  passthrough: false
});

var app = connect();
app.use(staticServe);
app.use(apiServe);
app.use(staticRemains);
app.listen(config.port, config.host);

winston.info('listening on ' + config.host + ':' + config.port);
