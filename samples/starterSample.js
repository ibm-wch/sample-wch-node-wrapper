/*
 * Copyright 2017  IBM Corp.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0 
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an 
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the 
 * specific language governing permissions and limitations under the License.
 */
'use strict'

// I've placed my credentials in a separate .env file. You can remove this line and
// add your credentials directly to the wchconfig variable down below. 
const env = require('../.env');
const wchconfig = {
        endpoint: 'delivery',
        baseUrl: env.credentials.baseurl // Required! The API Url found on the authoring UI
      };

// Since I'm in the sample directly I directly require the entry point...
const wchConnector = require('../src/index')(wchconfig);
// In your case this changes to:
// const wchConnector = require('sample-wch-node-connector')(wchconfig);

// A simple query against authoring... feel free to play around
wchConnector.search.query({
        query : '*:*',
        fields: 'creator, lastModified, classification',
        facetquery : ['classification:asset', 'lastModified:[2016-12-20T09:15:25.882Z TO NOW]'],
        rows : 5,
        sort : 'creator asc, lastModified desc',
        start : 0
      }).
      then(console.log);