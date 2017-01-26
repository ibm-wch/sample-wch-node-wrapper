/*
 * Copyright 2016  IBM Corp.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0 
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an 
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the 
 * specific language governing permissions and limitations under the License.
 */
'use strict';
//////////////////////////////
// WCH Node API Connector
//////////////////////////////

/// This connector provides generall access to the search API for WCH.
/// There are high level methods to access the different content types
/// and add common search patterns to the query.

const rp = require('request-promise'),
      Promise = require('bluebird'),
      Queue = require('promise-queue'),
      fs = require('fs'),
      path = require('path'),
      mime = require('mime-types');

let debug = false;
const errLogger = err => {if (debug) console.error("Error: ", err); throw err;}

// Immutable connection endpoints to WCH.
const wchEndpoints = require('./wchConnectionEndpoints');
const hashUtils = require('./util/hash');
const fileUtils = require('./util/file');

/**
 * In case of error try to login again. This is a quick-fix. More sophistiacted would be 
 * to observe the expiry date of the authentication cookie... clearly a TODO.
 * @param  {Object} options - Request-Promise options Object(value?: any)
 * @return {Promise} - Waiting for the response
 */
function send(options, retryHandling) {
  return rp(options).
         catch(errLogger).
         catch(err => retryHandling(err).
         then(() => rp(options)));
}

/**
 * Simple solr special char escaper. Based on 
 * https://cwiki.apache.org/confluence/display/solr/The+Standard+Query+Parser
 * @param  {String} str - The string to escape
 * @return {String} - The same string with all special solr chars escaped with '\'
 */
function escapeSolrChars(str) {
  const solrChars = /(\+|\-|\!|\(|\)|\{|\}|\[|\]|\^|\"|\~|\*|\?|\:|\/|\&{2}|\|{2}|\s)/gm;
  return str.replace(solrChars, (match) => match.replace(/(.)/gm, '\\$1') );
}

/**
 * Class for API access towards Watson Content Hub. ES6 Classes style.
 */
class WchConnector {
  /**
   * Initalizes the connection to WCH. This module is designed to be
   * instanciated multiple times. E.g. for logged in and anonymous uses 
   * in parallel.
   *
   * @param  {Object} configuration - Config options for WCH
   * @return {Class} - Initalized SDK ready to query for content
   */
  constructor (configuration) {
    // Init config with default
    this.configuration = Object.assign({
      endpoint: 'delivery',
      rejectUnauthorized: true,
      maxSockets: 10
    }, configuration);

    this.endpoint = wchEndpoints[this.configuration.endpoint];
    // Request-promise module default options
    this.cookieJar = rp.jar();
    this.options = {
          baseUrl: this.configuration.baseUrl || `${this.endpoint.baseUrl}`,
          uri: this.endpoint.uri_search,
          qsStringifyOptions: {encode:true},
          agentOptions: {
            rejectUnauthorized: this.configuration.rejectUnauthorized
          },
          jar: this.cookieJar,
          json: true,
          pool: {
            maxSockets: this.configuration.maxSockets,
            keepAlive: true
          }
      };

    let creds = this.configuration.credentials;
    this.loginstatus = (creds) ? this.dologin(creds, this.configuration.tenantid) : Promise.resolve(this.configuration.baseUrl);

    this.retryHandler = error => {
      if(error.statusCode === '403') {
        console.log('Authentication failed... try login again,');
        this.loginstatus = this.dologin(creds, this.configuration.tenantid);
      }
      throw error;
    };
  }

  /**
   * @return {Boolean} - True if the connector targets delivery system, otherwise false.
   */
  isDeliveryContext() {
    return this.configuration.endpoint === 'delivery';
  }

  /**
   * Login to WCH as authenticated user.
   * @param  {Object} credentials - Containing username and password
   * @param  {String} [credentials.usrname] - The blueid for an admin user
   * @param  {String} [credentials.pwd] - The password to the admin user
   * @param  {String} [tenantid] - Tenant id for the tenant to do the login for
   * @return {Promise} - Promise resolves with the WCH baseUrl as String
   */
  dologin(credentials, tenantid) {
    let username = credentials.usrname;
    let pwd = credentials.pwd;
    let request = Object.assign({}, 
      this.options, 
      {
        uri: this.endpoint.uri_auth,
        headers: {
          'x-ibm-dx-tenant-id': tenantid || undefined
        },
        auth: {
          user: credentials.usrname,
          pass: credentials.pwd
        },
        resolveWithFullResponse: true
    });
    return rp(request).
          catch(errLogger).
          then(data => data.headers['x-ibm-dx-tenant-base-url']);
  }

  /**
   * Convenience method to create valid delivery urls to asset resources. This method is mainly for 
   * the purpose of understanding on how a valid delivery URL can look like. 
   * @param  {Object} options - Options on how to generate the delivery Urls.
   * @param  {String} urlType - Defines the URL type. Valid options are `id`, `path` and `akami`. Default type is id.
   * @param  {Object} queryParams - Refines the query to match for a specific set of assets. All params as in `doSearch` are allowed expect for query and fields. 
   * @return {Promise} Resolves with an array of url strings, or just a string when there is only one result. 
   */
  getResourceDeliveryUrls(options) {
    let _options = options || {};
    let urlType = _options.urlType || 'id';
    let urlTypes = {
      id: {
        field:'resource',
        transform: (baseUrl, path, resource) => `${baseUrl}${path}/${encodeURIComponent(resource)}`
      },
      path: {
        field:'path',
        transform: (baseUrl, path, resource) => `${baseUrl}${path}?path=${encodeURIComponent(resource)}`
      },
      akami: {
        field:'path',
        transform: (baseUrl, path, resource) => `${baseUrl.replace('/api/', '/')}${encodeURIComponent(resource)}`
      }
    };

    let selectedUrlType = urlTypes[urlType];

    let searchQry = Object.
    assign(
      {}, 
      _options.queryParams, 
      {
        query: 'classification:asset',
        fields: selectedUrlType.field
      }
    );
    return Promise.join(this.loginstatus, this.doSearch(searchQry), 
      (base, result) => ({baseUrl: base, qry: result.documents})).
      then(result => result.qry.map((doc) => selectedUrlType.transform(result.baseUrl, wchEndpoints.delivery.uri_resource, doc[selectedUrlType.field])));
  }

  /**
   * Getter for content type definitions. Simple wrapper around search API. 
   * All params allowed as in doSearch except for query which is predefined.
   * @param  {Object} queryParams - The params object to build a query. Not all params are supported yet!
   * @param  {String} queryParams.fields - The fields returned from the search. Default are all fields.
   * @param  {String} queryParams.facetquery - Query to filter the main result. Cachable. Default is none.
   * @param  {Number} queryParams.rows - Amount of results returned. Default is 10 elements.
   * @param  {String} queryParams.sort - The order in which results are returned.
   * @param  {Number} queryParams.start - The first element in order to be returned.
   * @return {Promise} - Resolves when the search finished.
   */
  getContentTypeDefinitions(options) {
    let searchQry = Object.assign({}, options, {query: 'classification:content-type'});
    return this.doSearch(searchQry);
  }

  /**
   * Search API access. This should be your first access point when retrieving content from WCH. Why? Because the 
   * Search API will be available on authoring and delivery soon. Hence most of the queries you build can be used in 
   * both environments.
   * Other APIs like /authoring/v1/assets might not be aviailable on production for such purposes. 
   * @param  {Object} queryParams - The params object to build a query. Not all params are supported yet!
   * @param  {String} queryParams.query - The main query. Must be a valid SOLR query. Required. Default is all content.
   * @param  {String} queryParams.fields - The fields returned from the search. Default are all fields.
   * @param  {Number} queryParams.rows - Amount of results returned. Default is 10 elements.
   * @param  {String} queryParams.sort - The order in which results are returned.
   * @param  {Number} queryParams.start - The first element in order to be returned.
   * @param  {String} queryParams.facetquery - Query to filter the main result. Cachable. Default is none.
   * @param  {Bool}   queryParams.isManaged - If true the result set only contains on managed elements. If set to false on unmanaged elements are returned. (Only Managed elements are visible in the authoring UI) Default are all elements. No difference between managed an unmanaged.
   * @param  {Object} queryParams.dismax - Object containing dismax specific settings. If this param exists dismax parser is enabled.
   * @param  {Bool}   queryParams.dismax.extended - Boolean specifing if the extended dismax parsers should be used. Defaults to false (and hence to the dismax parser).
   * @param  {String} queryParams.dismax.queryFields - The index fields against which the query is evaluated. Can either be a string with multiple fields separated by a space or an array.
   * @param  {Object} queryParams.facet - Object containing facet specific settings. If this param exists faceting is enabled.
   * @param  {String} queryParams.facet.fields - The fields which are used for creating the facet. Can either be a string with multiple fields separated by a space or an array.
   * @param  {Object} queryParams.facet.range - Object containing range specific settings for facets.
   * @param  {String} queryParams.facet.range.fields - The fields which are used for creating the range facet. Can either be a string with multiple fields separated by a space or an array.
   * @param  {String} queryParams.facet.range.start - The starting point to create the range.
   * @param  {String} queryParams.facet.range.end - The endpoint of the range.
   * @param  {String} queryParams.facet.range.gap - Identifies the steps between a point in the range.
   * @param  {Number} queryParams.facet.mincount - Specifies the minimum counts required for a facet field to be included in the response.
   * @param  {Number} queryParams.facet.limit - Controls how many constraints should be returned for each facet.
   * @param  {Object} queryParams.facet.contains - Object containing the facet contains settings.
   * @param  {String} queryParams.facet.contains.text - Limits the terms used for faceting to those that contain the specified substring.
   * @param  {Bool}   queryParams.facet.contains.ignoreCase - If facet.contains is used, ignore case when searching for the specified substring.
   * @param  {Object} queryParams.override - Easy way to override settings for a specific field.
   * @return {Promise} - Resolves when the search finished.
   */
  doSearch(queryParams) {
    // General standard query variables
    let _query = queryParams.query || '*:*';
    let _fields = queryParams.fields || '*';
    let _rows = ('rows' in queryParams && typeof queryParams.rows === 'number') ? queryParams.rows : 10;
    let _sort = queryParams.sort || '';
    let _start = queryParams.start || 0;
    let _fq = queryParams.facetquery || '';
    // Edismax main parser variables
    let _useDismax = 'dismax' in queryParams;
    let _dismaxType = (_useDismax && queryParams.dismax.extended) ? 'edismax' : 'dismax';
    let _defType = (_useDismax) ? _dismaxType : 'lucene';
    let _qf = (_useDismax) ? queryParams.dismax.queryFields : undefined;
    // Facet specific variables
    let _useFacets = queryParams.facet !== undefined;
    let _facet = queryParams.facet || {};
    let _facetFields = _facet.fields || [];
    let _facetMincount = _facet.mincount || 0;
    let _facetLimit = _facet.limit || 10;
    let _facetContains = _facet.contains || {};
    let _facetContainsText = _facetContains.text || undefined; 
    let _facetContainsIgnoreCase = _facetContains.ignoreCase || undefined;
    let _facetRange = _facet.range || {};
    let _facetRangeFields = _facetRange.fields || [];
    let _facetRangeStart = _facetRange.start || undefined;
    let _facetRangeEnd = _facetRange.end || undefined;
    let _facetRangeGap = _facetRange.gap || undefined;
    // Override settings for specific fields
    let _override = queryParams.override || {};
    let f = {};
    for(let key in _override) {
        f['f.'+key] = _override[key];
    }
    // WCH specific variables
    let _isManaged = ('isManaged' in queryParams) ? `isManaged:("${queryParams.isManaged}")` : '';

    return this.loginstatus.
      then((base) => Object.assign({},
        this.options,
        {
          baseUrl: base, 
          qs: Object.assign({
            q: _query,
            fl: _fields,
            fq: new Array().concat(_fq, _isManaged),
            rows: _rows,
            sort: _sort,
            start: _start,
            defType: _defType,
            qf: _qf,
            facet: _useFacets,
            'facet.range': _facetRangeFields,
            'facet.range.start': _facetRangeStart,
            'facet.range.end': _facetRangeEnd,
            'facet.range.gap': _facetRangeGap,
            'facet.contains': _facetContainsText,
            'facet.contains.ignoreCase': _facetContainsIgnoreCase, 
            'facet.mincount': _facetMincount,
            'facet.limit': _facetLimit,
            'facet.field' : _facetFields
          }, f),
          useQuerystring: true
        })).
      then(options => send(options, this.retryHandler));
  }

  /*----------  Convinience Methods for Search Queries  ----------*/
  
  getContentById(type, id, filter) {
    var _type = escapeSolrChars(type) || '',
        _id = escapeSolrChars(id) || '',
        _filter = filter || '';
    return this.doSearch({
            query: `id:${_filter}${_type}\\:${_id}`,
            rows: 1
        });
  }

  getAllAssetsAndContent(filter, rows, sortAsc) {
    var _filter = (filter) ? ' '+filter : '',
        _sort = `lastModified ${(sortAsc) ? 'asc' : 'desc'}`;
    return this.doSearch({
      query: '*:*',
      facetquery: _filter, 
      rows: rows,
      sort: _sort
    });
  }

  getAllContentOfType(type, rows, sortAsc, start) {
    var _filter = (type) ? ' AND type:'+type : '',
        _sort = `lastModified ${(sortAsc) ? 'asc' : 'desc'}`;

    return this.doSearch({
      query: `classification:content${_filter}`, 
      rows: rows,
      sort: _sort,
      start: start
    });
  }

  getImageProfileWithName(name) {
    var _filter = (name) ? ' AND name:'+name : '';
    return this.doSearch({
      query: `classification:image-profile${_filter}`, 
      rows: 1
    });
  }

}

/**
 * Class containing all authoring only API methods. Rule of thumb: All create, update & delete
 * methods are only available in authoring.
 */
class WchAuthoringConnector extends WchConnector {

  /**
   * Create a resource with the given filename. Fallback is resource name. You can also decide to get a random
   * ID if you dont care through the matching param.
   * @param  {Object}  options - The settings required to upload a resource
   * @param  {String}  [options.filePath] - Path to the resource file on system.
   * @param  {String}  [options.fileName] - Name of the file inside of WCH. Filename is the unique id of this resource.
   * @param  {Boolean} [options.randomId] - Define if ID of the resource is based on the filename or a random UUID.
   * @return {Promise} - Resolves with the response body when the resource is created
   */
  createResource(options) {
    if(!options.filePath) new Error('Need a file to upload');
    let _randomId = options.randomId || false;
    let _fileName = options.fileName || options.filePath;
    let extractedExtname = path.basename(_fileName, path.extname(_fileName));
    let contentType = mime.lookup(path.extname(options.filePath));
    let resourceId = (_randomId) ? '' : `/${encodeURIComponent(extractedExtname)}`;
    // Be aware that resources are the binary representation of an asset. Hence these resources
    // can get rather large in size. That's why this part is implemented as a stream in order to reduce
    // the memory footprint of this node sample app.
    
    let hashStream = fs.createReadStream(options.filePath);
    let bodyStream = fs.createReadStream(options.filePath);

    return Promise.join(this.loginstatus, hashUtils.generateMD5Hash(hashStream), fileUtils.getFileSize(options.filePath),
      (base, md5file, fileSize) => Object.assign({},
        this.options, 
        {
          baseUrl: base,
          uri: `${this.endpoint.uri_resource}${resourceId}`,
          method: (_randomId) ? 'POST': 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': fileSize
          },
          qs: {
            name: path.basename(options.filePath),
            md5: md5file
          },
          json: false
        })
      ).      
      then(options => {
        return new Promise((resolve, reject)=> {
          let body = '';
          let request = bodyStream.pipe(rp(options));
          request.on('data', data => {body += data});
          request.on('end', () => (body) ? resolve(JSON.parse(body)) : resolve(undefined));
          request.on('error', reject);
        });
      }).
      then(data => data || { id : extractedExtname });
  }

  /**
   * Create a new asset definition.
   * @param  {Object} assetDef - The asset JSON definition
   * @param  {String} assetDef.id - The id of the new assset
   * @param  {Object} assetDef.tags - Tag structure of assets. Consists of active, declined and watson tags.
   * @param  {Array}  assetDef.tags.values - String array with active tags for this asset. 
   * @param  {Array}  assetDef.tags.declined - String array with declined tags for this asset.
   * @param  {Array}  assetDef.tags.analysis - String array with tags from watson.
   * @param  {String} assetDef.description - Description of the asset to be uploaded
   * @param  {String} assetDef.name - The visible name of this asset for authoring UI.
   * @param  {String} assetDef.resource - The resource ID to the binary file this asset references.
   * @param  {Path}   assetDef.path - When this attribute is set the asset is handled as a web asset and not visible in the authoring UI.
   * @return {Promise} - Resolves when the asset is created
   */
  createAsset(assetDef) {
    return this.loginstatus.
      then((base) => Object.assign({}, 
        this.options, 
        {
          baseUrl: base,
          uri: this.endpoint.uri_assets,
          method: 'POST',
          qs: {
            analyze: true, // These two parameters define if watson tagging is active...
            autocurate: false // ... and if all tags are accepted automatically
          },
          body: assetDef
        })
      ).
      then(options => send(options, this.retryHandler));
  }

  /**
   * Updates an existing asset. The id of the assetDef has to match an existing asset.
   * @param  {Object} assetDef - The asset JSON definition
   * @param  {String} assetDef.id - The id of the new assset
   * @param  {Object} assetDef.tags - Tag structure of assets. Consists of active, declined and watson tags.
   * @param  {Array}  assetDef.tags.values - String array with active tags for this asset. 
   * @param  {Array}  assetDef.tags.declined - String array with declined tags for this asset.
   * @param  {Array}  assetDef.tags.analysis - String array with tags from watson.
   * @param  {String} assetDef.description - Description of the asset to be uploaded
   * @param  {String} assetDef.name - The visible name of this asset for authoring UI.
   * @param  {String} assetDef.resource - The resource ID to the binary file this asset references.
   * @param  {Path}   assetDef.path - When this attribute is set the asset is handled as a web asset and not visible in the authoring UI.
   * @return {Promise} - Resolves when the asset is created
   */
  updateAsset(assetDef) {
    return this.loginstatus.
      then((base) => Object.assign({}, 
        this.options, 
        {
          baseUrl: base,
          uri: `${this.endpoint.uri_assets}/${encodeURIComponent(assetDef.id)}`,
          method: 'PUT',
          qs: {
            analyze: true
          },
          body: assetDef
        })
      ).
      then(options => send(options, this.retryHandler));
  }

  /**
   * Convinience method which uploads and creates a resource and afterwards an asset definition.
   * @param  {String} options - Options for asset upload.
   * @param  {String} [options.filePath] - Path to the file
   * @param  {String} [options.fileName] - Name of the file
   * @param  {Object} [options.assetDef] - The asset JSON definition
   * @param  {String} [options.assetDef.id] - The id of the new assset
   * @param  {Object} [options.assetDef.tags] - Tag structure of assets. Consists of active, declined and watson tags.
   * @param  {Array}  [options.assetDef.tags.values] - String array with active tags for this asset. 
   * @param  {Array}  [options.assetDef.tags.declined] - String array with declined tags for this asset.
   * @param  {Array}  [options.assetDef.tags.analysis] - String array with tags from watson.
   * @param  {String} [options.assetDef.description] - Description of the asset to be uploaded
   * @param  {String} [options.assetDef.name] - The visible name of this asset for authoring UI.
   * @param  {Path}   [options.assetDef.path] - When this attribute is set the asset is handled as a web asset and not visible in the authoring UI.
   * @param  {Array}  [options.assetDef.categoryIds] - String Array containing Categoriy IDs
   * @return {Promise} - Resolves when the asset & resource is created
   */
  uploadAsset(options) {
    return this.createResource(options.resourceDef).
      then(resourceResp => (typeof resourceResp === 'string') ? JSON.parse(resourceResp) : resourceResp).
      then(resourceResp => Object.assign(
        {},
        options.assetDef, 
        {
          tags: {
            values:   options.assetDef.tags.values.splice(0),
            declined: options.assetDef.tags.declined.splice(0),
            analysis: options.assetDef.tags.analysis
          },
          resource: resourceResp.id
        })).
      then(asset => this.createAsset(asset));
  }

  /**
   * Creates a new content type based on the definition. Recommendation: Use authoring UI. A content type
   * becomes complicated fast!
   * @param  {Object} typeDefinition - JSON Object representing the content type definition
   * @return {Promise} - Resolves when the content type is created
   */
  createContentType(typeDefinition) {
    return this.loginstatus.
       then((base) => Object.assign({},
        this.options, 
        {
          baseUrl: base,
          uri: this.endpoint.uri_types,
          method: 'POST',
          body: typeDefinition
        })
      ).
      then(options => send(options, this.retryHandler));
  }

  /**
   * Updates an existing content type. If somebody alters the definition 
   * before you update your changes this method fails. You can only update
   * the most current version known to WCH. Recommendation: Use authoring UI. A content type
   * becomes complicated fast!
   * @param  {Object} typeDefinition - JSON Object representing the content type definition
   * @return {Promise} - Resolves when the content type is updated
   */
  updateContentType(typeDefinition) {
    return this.loginstatus.
       then((base) => Object.assign({},
        this.options, 
        {
          baseUrl: base,
          uri: this.endpoint.uri_types+'/'+encodeURIComponent(typeDefinition.id),
          method: 'PUT',
          body: typeDefinition
        })
      ).
      then(options => send(options, this.retryHandler));
  }

  /**
   * Deletes a single asset based on it's id.
   * @param  {String} assetId - The WCH unique Asset ID
   * @return {Promise} - Resolved after the resource was deleted
   */
  deleteAsset(assetId) {
    return this.loginstatus.
      then((base) => Object.assign({}, 
        this.options, 
        {
          baseUrl: base,
          uri: this.endpoint.uri_assets+'/'+encodeURIComponent(assetId),
          method: 'DELETE'
        })
      ).
      then(options => send(options, this.retryHandler)).
      then(() => `Deleted ${assetId} succesfully.`).
      catch(errLogger).
      catch(err => `An error occured deleting ${assetId}: Status ${err.statusCode}. Enable debugging for details.`);
  }

  /**
   * Deletes the specified amount of assets matching the query.
   * @param  {String}  query  - Facet query specifing the assets to be deleted
   * @param  {Integer} rows - Amount of elements that will be deleted
   * @return {Promise} - Resolves when all assets are deleted
   */
  deleteAssets(query, rows) {
    let parallelDeletes = Math.ceil(this.configuration.maxSockets / 5); // Use 1/5th of the available connections in parallel
    let amtEle = rows || 100;
    let queue = new Queue(parallelDeletes, amtEle);
    let qryParams = {query: `classification:asset`, facetquery: query, fields:'id', rows: amtEle};
    return this.doSearch(qryParams).
            then(data => (data.documents) ? data.documents : []).
            map(document => (document.id.startsWith('asset:')) ? document.id.substring('asset:'.length) : document.id).
            map(docId => queue.add(() => this.deleteAsset(docId)))
            .all();
  }

  /**
   * Returns a list of all child categories based on the given ID. The given ID is not included in the 
   * searchresult.
   * @param  {String}  categoryId - UUID of the category to search for
   * @param  {Object}  config - Config on what to retrieve.
   * @param  {Boolean} config.recurse - If true it will also include children of children, if false only direct childs are returned
   * @param  {Number}  config.limit - How many items are returned max.
   * @param  {Number}  config.offset - Where to start returning. Useful for pagination.   
   * @return {Promse} - Resolves when the category tree was retrieved.
   */
  getCategoryTree(categoryId, config) {
    let _config = config || {};
    let recurse = _config.recurse || true;
    let limit = _config.limit || 100;
    let offset = _config.offset || 0;

    return this.loginstatus.
      then((base) => Object.assign({},
        this.options, 
        { 
          baseUrl: base,
          uri: `${this.endpoint.uri_categories}/${encodeURIComponent(categoryId)}/children`,
          method: 'GET',
          qs: {
            recurse: true,
            limit: 100,
            offset: 0
          }
        })
      ).
      then(options => send(options, this.retryHandler))
  }

  /**
   * Creates a new category element. If the parent is empty this will
   * create a taxonomy. 
   * @param  {Object} categoryDef - The category definition
   * @param  {String} [name] - The name of the category
   * @param  {String} [parent] - The id of the parent category. 
   * @return {Promise} - Resolves when the category was created
   */
  createCategory(categoryDef) {
    return this.loginstatus.
      then((base) => Object.assign({},
        this.options, 
        { baseUrl: base,
          uri: this.endpoint.uri_categories,
          method: 'POST',
          body: categoryDef
        })).
      then(options => send(options, this.retryHandler));
  }

  /**
   * Deletes a category item all all its children.
   * @param  {String} categoryId - The uniue id of the category item to delete
   * @return {Promis} - Resolves when the element is deleted.
   */
  deleteCategory(categoryId) {
    return this.loginstatus.
      then((base) => Object.assign({},
        this.options, 
        { baseUrl: base,
          uri: `${this.endpoint.uri_categories}/${encodeURIComponent(categoryId)}`,
          method: 'DELETE'
        })
      ).
      then(options => send(options, this.retryHandler)).
      catch(errLogger);
  }

  /* Convinience method to create taxonomies. */
  createCategoryLvl(taxonomyLvl, categoryMap) {
    return new Promise((resolve, reject) => {
      if(taxonomyLvl.name) {
        this.createCategory({name:taxonomyLvl.name}).
        then(result => categoryMap.set(taxonomyLvl.name, result.id)).
        then(() => taxonomyLvl.childs).
        map(child => this.createCategory({name:child, parent: categoryMap.get(taxonomyLvl.name)})).
        map(result => categoryMap.set(result.name, result.id)).
        then(resolve).
        catch(reject); 
      } else {
        Promise.resolve(taxonomyLvl.childs).
        map(child => this.createCategory({name:child, parent: categoryMap.get(taxonomyLvl.parent)})).
        map(result => categoryMap.set(result.name, result.id)).
        then(resolve).
        catch(reject);
      }
    });
  }

  /**
   * Creates a complete taxonomy based on a json definition file. It's also possible to define multiple 
   * taxonomies in the same file. Make sure that the names are exclusive inside a single taxonomy. 
   * @param  {Array}  taxonomyDefinition - Object Array. Each Object represents a level inside a taxonomy.
   * @param  {Object} taxonomyLvl - Represents either the root of a taxonomy or a level inisde a taxonomy. Stored inside the taxonomyDefinition.
   * @param  {String} name  - Indicates the start/name of a taxonomy. If name is present the parent attribute will be ignored.
   * @param  {String} parent - Reference to the parent category. Will internally mapped to the category ID.
   * @param  {Array} childs - String Array containing the names of the categories on this level. 
   * @return {Promise} - Resolves when the taxonomy is completly created.
   */
  createTaxonomies(taxonomyDefinition) {
    let nameMap = new Map();
    return Promise.resolve(taxonomyDefinition).
    each(taxonomyLvl => this.createCategoryLvl(taxonomyLvl, nameMap));
  }

  /**
   * Deletes all taxonomies matched by this query. If the query is empty all taxonomies will get deleted.
   * @param  {String} query - A valid solr facet query element specifing the taxonomies to delete. 
   * @param  {Number} rows - the amount of matched elements to get deleted.
   * @return {Promise} - Resolves when all matched elements are deleted. 
   */
  deleteTaxonomies(query, rows) {
    let amtEle = rows || 100;
    let qryParams = {query: 'classification:taxonomy', facetquery: query, fields:'id', rows: amtEle};
    return this.doSearch(qryParams).
      then(data => (data.documents) ? data.documents : []).
      map(document => (document.id.startsWith('taxonomy:')) ? document.id.substring('taxonomy:'.length) : document.id).
      map(id => this.deleteCategory(id)).
      all();
  }

} 

/**
 * Initalization of the wch connector.
 * @param  {Object} config - Optional parameter with credentials and default settings
 * @return {Object} - Wrapper to common API calls towards Watson Content Hub
 */
module.exports = function(config) {
  return (config.endpoint === 'delivery') ? new WchConnector(config) : new WchAuthoringConnector(config);
}