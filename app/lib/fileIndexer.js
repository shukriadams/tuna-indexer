/**
 * Wraps indexing logic. Repeatedly scans an instance of FileWatcher for file changes.
 * When changes are detected, gets files from FileWatcher and writes index data to disk.
 * 
 * Index data consists of four files 
 * 1 - an xml file containing all valid tagged music files
 * 2 - a small json file containing date when xml file was last written to
 * 3 - a text log of all errors
 * 4 - a lokijs database
 * 
 * The xml and json file are readable remotely via Dropbox / Nextcloud etc API, and are 
 * meant to be consumed by the mystream server.
 * 
 * The text log is for local use - it's a quick-and-dirty way of reporting file read
 * errors to user. It will typically show files which are not propertly tagged.
 * 
 * The lokijs file is for local use - it keeps track of music files already read so we
 * don't have to continuously rescan all files on each time one file changes. We can also
 * query lokijs to display state on local UI.
 */
const 
    path = require('path'),
    os = require('os'),
    jsonfile = require('jsonfile'),
    XMLWriter = require('xml-writer'),
    electron = require('electron'),
    jsmediatags = require('jsmediatags'),
    pathHelper = require('./pathHelper'),
    isTagValid = require('./istagValid'),
    Lokijs = require('lokijs'),
    fs = require('fs-extra');

module.exports = class {
    
    constructor(fileWatcher){
        this._fileWatcher = fileWatcher;
        // callback for when status text is written
        this._onStatusChanged = null;
        // callback when indexing starts
        this._onIndexingStart = null;
        // callback when indexing is done
        this._onIndexingDone = null;
        this._onProgress = null;
        this._interval;
        this._busy = false;
        this._errorsOccurred = false;
        this._processedCount = 0;
        this._toProcessCount = 0;
        this._fileKeys = [];
        this._fileTable = null; // lokijs collection containing file data

        const dataFolder = path.join(electron.remote.app.getPath('appData'), 'myStreamCCIndexer');
        this._lokijsPath = path.join(dataFolder, 'loki.json'),
        this.logPath = path.join(dataFolder, 'output.log');
        this._loki = new Lokijs(this._lokijsPath);
    }

    async start(){

        // start new loki or load existing from file
        if (await fs.pathExists(this._lokijsPath))
           await this._loadLokiFromFile();
        else 
            this._createCollection();

        // start handler for observed file changes    
        this._interval= setInterval(async ()=>{
            await this._startHandlingFileChanges();
        }, 1000);
    }


    /**
     * Creates and sets loki table, to be used only on new loki file. if file already
     * exists, load table from file instaed
     */
    _createCollection(){
        this._fileTable = this._loki.addCollection('fileData',{ unique:['file']});
    }
    
    async _readID3Tag(filePath){
        return new Promise((resolve, reject)=>{
            try {
                jsmediatags.read(filePath, {
                    onSuccess: tag => {
                        resolve(tag)
                    },
                    onError: error => {
                        reject(error)
                    }
                });
            }catch(ex){
                reject(ex);
            }
        })        
    }

    /**
     * Loads loki from file. if file is corrupt, destroys file and starts new collection
     */
    async _loadLokiFromFile(){
        return new Promise((resolve, reject)=>{
            try {
                this._loki.loadDatabase({}, async()=>{
                    this._fileTable = this._loki.getCollection('fileData');
                    // if table load failed, file is corrupt, delete
                    if (!this._fileTable){
                        await fs.remove(this._lokijsPath);
                        this._createCollection();
                        console.log('loki file corrupt, resetting');
                    }

                    resolve();
                });
            }catch(ex){
                reject(ex);
            }
        })
    }

    async _startHandlingFileChanges(){

        if (!this._fileWatcher.dirty)
            return;

        if (this._busy)
            return;

        this._fileWatcher.dirty = false;
        this._busy = true;
        this._errorsOccurred = false;
        if (this._onIndexingStart)
            this._onIndexingStart();

        // clear output log
        await fs.outputFile(this.logPath, '');

        // reset 
        this._processedCount = -1;
        this._fileKeys = Object.keys(this._fileWatcher.files),
        this._toProcessCount = this._fileKeys.length;

        // start handling files
        this._handleNextFile();
    }

    async _handleNextFile(){
        setImmediate(async()=>{
            this._processedCount ++;

            // check if all objects have been processed, if so write xml from loki and exit.
            // IMPORTANT : do not refactor this back into the try block, else
            // this method will recurse forever!
            if (this._processedCount >= this._toProcessCount){
                this._finishHandlingChanges();
                return;
            }

            try{
                
                var file = this._fileKeys[this._processedCount];

                // ensure file exists, during deletes this list can be slow to update
                if (!await fs.pathExists(file)) {
                    this._fileWatcher.remove(file);
                    return;
                }

                // check if file data is cached in loki, and if file was updated since then
                var fileStats,
                    fileCachedData = this._fileTable.by('file', file);

                if (fileCachedData){
                    fileStats = fs.statSync(file); // todo make async
                    // if file hasn't changed since last update, ignore it
                    if (fileStats.mtime.toString() === fileCachedData.mtime)
                        return;
                }

                var insert = false;
                if (!fileCachedData){
                    fileCachedData = {
                        file : file
                    };
                    insert = true;
                }

                let tag = await this._readID3Tag(file);

                if (tag.type === 'ID3' || tag.type === 'MP4'){
                    var fileNormalized = pathHelper.toUnixPath(file);

                    fileCachedData.dirty = true;
                    fileCachedData.mtime = fileStats ? fileStats.mtime.toString() : '';
                    fileCachedData.tagData = {
                        name : tag.tags.title,
                        album : tag.tags.album,
                        track : tag.tags.track,
                        artist : tag.tags.artist,
                        clippedPath : fileNormalized.replace(this._fileWatcher.watchPath, '/')
                    };
                    fileCachedData.isValid = isTagValid( fileCachedData.tagData);

                    var percent = Math.floor(this._processedCount / this._toProcessCount * 100);
                    if (this._onProgress)
                        this._onProgress(`${percent}% : ${tag.tags.title} - ${tag.tags.artist}`);

                    if (insert)
                        this._fileTable.insert(fileCachedData);
                    else
                        this._fileTable.update(fileCachedData);
                }

            } catch(ex){
                var message = '';

                if (ex.type && ex.type === 'tagfail'){
                    message = file + ' tag read fail.';
                } else {
                    message = file + ' could not be read, is it properly tagged?';
                }

                fileCachedData.dirty = false;
                fileCachedData.mtime = fileStats ? fileStats.mtime.toString() : '';
                fileCachedData.tagData  = null;

                if (insert)
                    this._fileTable.insert(fileCachedData);
                else
                    this._fileTable.update(fileCachedData);

                this.writeToLog(`${message} : ${JSON.stringify(ex)}`);
                this._errorsOccurred = true;
            }
            finally{
                this._handleNextFile();
            }
        });
    }


    /**
     * Called after all files have been read. Updates Loki with file state.
     * If any file changes were detected, writes a totally new XML index file.
     */
    async _finishHandlingChanges(){
        try {
            this._loki.saveDatabase();

            var writer = null;
    
            // check for dirty files in loki. If nothing, indexing is done
            var dirty =  this._fileTable.find({dirty : true});
            if (!dirty.length)
            {
                // move back to ui
                //_btnReindex.classList.remove('button--disable');
                return;
            }
    
            // setStatus('Indexing ... ');
    
            // force rebuild files key incase we needed to delete items along the way
            var allProperties = Object.keys(this._fileWatcher.files),
                lineoutcount = 0,
                id3Array = [],
                writer = new XMLWriter();
    
            writer.startDocument();
            writer.startElement('items');
            writer.writeAttribute('date', new Date().getTime());
    
            for (var i = 0 ; i < allProperties.length ; i ++) {
    
                lineoutcount ++;
    
                var fileData = this._fileTable.by('file', allProperties[i]);
                if (!fileData)
                    continue; // yeah, this should never happen
    
                if (!fileData.tagData){
                    this.writeToLog(`${allProperties[i]} has no tag data`);
                    continue;
                }
    
                var id3 = fileData.tagData;
    
                // file isn't fully tagged - warn user about this
                if (!isTagValid(id3)){
                    this.writeToLog(`${ id3.clippedPath} isn't properly tagged`);
                    this._errorsOccurred = true;
                    continue;
                }
    
                writer.startElement('item');
                writer.writeAttribute('album', id3.album);
                writer.writeAttribute('artist', id3.artist);
                writer.writeAttribute('name', id3.name);
                writer.writeAttribute('path', id3.clippedPath);
                writer.endElement();
    
                // setStatus(`Indexing ${lineoutcount} of ${id3Array.length}, ${id3.artist} ${id3.name}`);
            }
    
            writer.endElement();
            writer.endDocument();
    
            const xml = writer.toString(),
                indexPath = pathHelper.getIndexPath(this._fileWatcher.watchPath);
    
            await fs.outputFile(indexPath, xml);
    
            // write status data for fast reading
            let status = {
                date : new Date().getTime()
            }
            
            const statusPath = pathHelper.getStatusPath(this._fileWatcher.watchPath);
            jsonfile.writeFileSync(statusPath, status);
    
            // clean dirty records
            for (var i = 0 ; i < dirty.length ; i ++){
                var record = dirty[i];
                record.dirty = false;
                this._fileTable.update(record);
            }
    
            // remove orphans
            var orphans = this._fileTable.where(r =>{
                return allProperties.indexOf(r.file) === -1;
            });
    
            for (var i = 0 ; i < orphans.length ; i ++) {
                this._fileTable.remove(orphans[i]);
            }
    
            this._loki.saveDatabase();
        } finally{
            if (this._onIndexingDone)
                this._onIndexingDone();

            this._busy = false;
        }


        //setStatus('Indexing complete');

    }   


    /**
     * Destroys all index files on disk
     */
    async wipe(){
        await fs.remove(pathHelper.getIndexPath(this._fileWatcher.watchPath));

        await fs.remove(pathHelper.getStatusPath(this._fileWatcher.watchPath));

        this._fileTable.clear();
        this._loki.saveDatabase();
    }


    /**
     * Gets a list of all files currently indexed. list is pulled via Loki,
     * not from drive
     */
    getAllFiles(){
        return this._fileTable.find({ });
    }

    writeToLog(text){
        fs.appendFile(this.logPath, text + os.EOL, err => {
            if (err)
                console.log(err);
        });
    }

    onProgress(callback){
        this._onProgress = callback;
    }

    onIndexingStart(callback){
        this._onIndexingStart = callback;
    }

    onIndexingDone(callback){
        this._onIndexingDone = callback;
    }

    onStatusChange(callback){
        this._onStatusChanged = callback;
    }
  
    _setStatus(status){
        if (this._onStatusChanged)
           this._onStatusChanged(status);
    }

    dispose(){
        if (this._interval)
            clearInterval(this._interval);
    }
}