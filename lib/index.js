'use strict'

const mysql = require('mysql')
const helpers = require('./helpers')
const primaryKeyTypes = helpers.primaryKeyTypes
const postgresTypeMap = helpers.postgresTypeMap
const getCode = helpers.getCode
const inputRecord = helpers.inputRecord
const outputRecord = helpers.outputRecord
const inputValue = helpers.inputValue

const foreignKeyMap = {
  smallserial: 'smallint',
  serial: 'integer',
  bigserial: 'bigint'
}


/**
 * MySQL adapter.
 */
module.exports = Adapter => class PostgreSQLAdapter extends Adapter {

  /**
   * Table setup happens at this stage. The default policy is completely
   * non-destructive, so tables and columns may only be added but not modified
   * in any way. Migrations are outside of the scope of this adapter.
   */
  connect () {
    const Promise = this.Promise
    const recordTypes = this.recordTypes
    const options = this.options
    const primaryKey = this.keys.primary
    const isArrayKey = this.keys.isArray
    const typeKey = this.keys.type
    const linkKey = this.keys.link
    const types = Object.keys(recordTypes)

    if (!('url' in options))
      throw new Error('A connection URL is required.')

    let primaryKeyType = options.primaryKeyType || String

    if (typeof primaryKeyType !== 'string') {
      if (!primaryKeyTypes.has(primaryKeyType))
        throw new Error('The primary key type is invalid.')

      primaryKeyType = postgresTypeMap.get(primaryKeyType)
    }
    else primaryKeyType = primaryKeyType.toLowerCase()

    const foreignKeyType = primaryKeyType in foreignKeyMap ?
      foreignKeyMap[primaryKeyType] : primaryKeyType

    if (!('isNative' in options)) options.isNative = false
    if (!('typeMap' in options)) options.typeMap = {}

    const typeMap = options.typeMap
    const url = options.url

    const mysqlConnection = mysql.createConnection(url);

    return new Promise((resolve, reject) =>
      mysqlConnection.connect(error => {
        if (error) return reject(error)

        this.client = mysqlConnection

        console.log("connected to:"+url)
        return resolve()
    }))

    // Make sure that tables exist.
    .then(() => Promise.all(types.map(type =>
    new Promise((resolve, reject) => {
      const mappedType = typeMap[type] || type
      const createTable = `create table if not exists ${mappedType} ` +
        `(${primaryKey} varchar(16) primary key)`
			console.log(createTable)
      this.client.query(createTable, error =>
        error ? reject(error) : resolve())
    }))))

    // Get column definitions.
    .then(() => Promise.all(types.map(type =>
    new Promise((resolve, reject) => {
      const mappedType = typeMap[type] || type
      const getColumns = 'select * from information_schema.columns ' +
        `where table_name = '${mappedType}'`
      this.client.query(getColumns, (error, result) =>
        error ? reject(error) : resolve(result))
    }))))

    // Add missing columns.
    .then(results => {
      const tableColumns = results.reduce((map, result, index) => {
        map[types[index]] = result
        return map
      }, {})

      const addColumns = []
      const addColumn = (type, field) => new Promise((resolve, reject) => {
        const fieldDefinition = recordTypes[type][field]
        const isArray = fieldDefinition[isArrayKey]
        const dataType = typeKey in fieldDefinition ?
          postgresTypeMap.get(fieldDefinition[typeKey]) : foreignKeyType
        const link = fieldDefinition[linkKey]

        // Need to revisit this, when or if Postgres implements arrays of
        // foreign keys.
        const isForeignKey = link && !isArray

        const mappedType = type in typeMap ? typeMap[type] : type
        const addColumn = `alter table ${mappedType} add column ` +
          `${field} ${dataType}` +
          `${isForeignKey && options.useForeignKeys ?
          (` references "${link in typeMap ? typeMap[link] : link}" ` +
          'on delete set null') : ''}`

				console.log(addColumn)
        this.client.query(addColumn, error =>
          error ? reject(error) : resolve())
      })

      Object.keys(tableColumns).forEach(type => {
				Object.getOwnPropertyNames(recordTypes[type]).forEach( (recordType) => {
					var exist = false
					tableColumns[type].map( function(item){
						if( item.COLUMN_NAME && item.COLUMN_NAME == recordType )
							exist = true
					})
					if( !exist ) addColumns.push(addColumn(type, recordType))
				})
      })
      return Promise.all(addColumns)
    })

    .then(() => null)
  }


  disconnect () {
    this.client.end(err => {
      delete this.client
    })
    return Promise.resolve()
  }


  find (type, ids, options) {
    // Handle no-op.
    if (ids && !ids.length) return super.find()

    // Set options if falsy.
    if (!options) options = {}

    const Promise = this.Promise
    const client = this.client
    const recordTypes = this.recordTypes
    const typeMap = this.options.typeMap
    const primaryKey = this.keys.primary
    const isArrayKey = this.keys.isArray
    const fields = recordTypes[type]

    let columns = Object.keys(options.fields || {})
    columns = columns.length ?
      (columns.every(column => options.fields[column]) ?
        [ primaryKey ].concat(columns) :
        [ primaryKey ].concat(Object.keys(fields)
          .filter(field => !columns.some(column => column === field)))
      ).map(column => `"${column}"`).join(', ') : '*'

    const selectColumns = `select ${columns} from ` +
      `"${typeMap[type] || type}"`
    const query = options.query || (x => x)
    const parameters = []
    let index = 0
    let where = []
    let order = []
    let slice = ''

    if (ids) {
      where.push(`"${primaryKey}" in (${ids.map(() => {
        index++
        return `$${index}`
      }).join(', ')})`)
      Array.prototype.push.apply(parameters, ids)
    }

    for (const field in options.match) {
      const isArray = fields[field][isArrayKey]
      let value = options.match[field]

      if (!isArray) {
        if (Array.isArray(value))
          where.push(`"${field}" in (${value.map(mapValue).join(', ')})`)
        else {
          index++
          parameters.push(value)
          where.push(`"${field}" = $${index}`)
        }
        continue
      }

      // Array containment.
      if (!Array.isArray(value)) value = [ value ]
      where.push(`"${field}" @> array[${value.map(mapValueCast).join(', ')}]`)
    }

    for (const field in options.exists) {
      const isArray = fields[field][isArrayKey]
      const value = options.exists[field]

      if (!isArray) {
        where.push(`"${field}" ${value ? 'is not null' : 'is null'}`)
        continue
      }

      where.push(`coalesce(array_length("${field}", 1), 0) ${
        value ? '> 0' : '= 0'}`)
    }

    for (const field in options.range) {
      const isArray = fields[field][isArrayKey]
      const value = options.range[field]

      if (!isArray) {
        if (value[0] != null) {
          index++
          parameters.push(value[0])
          where.push(`"${field}" >= $${index}`)
        }
        if (value[1] != null) {
          index++
          parameters.push(value[1])
          where.push(`"${field}" <= $${index}`)
        }
        continue
      }

      if (value[0] != null) {
        index++
        parameters.push(value[0])
        where.push(`coalesce(array_length("${field}", 1), 0) >= $${index}`)
      }
      if (value[1] != null) {
        index++
        parameters.push(value[1])
        where.push(`coalesce(array_length("${field}", 1), 0) <= $${index}`)
      }
    }

    where = where.length ? `where ${where.join(' and ')}` : ''

    for (const field in options.sort) {
      const isArray = fields[field][isArrayKey]
      order.push((isArray ?
        `coalesce(array_length("${field}", 1), 0) ` : `"${field}" `) +
        (options.sort[field] ? 'asc' : 'desc'))
    }

    order = order.length ? `order by ${order.join(', ')}` : ''

    if (options.limit) slice += `limit ${options.limit} `
    if (options.offset) slice += `offset ${options.offset} `

    const findRecords = query(
      `${selectColumns} ${where} ${order} ${slice}`, parameters)

    // Parallelize the find method with count method.
    return Promise.all([
      new Promise((resolve, reject) =>
        client.query(findRecords, parameters.length ? parameters : null,
          (error, result) => error ? reject(error) : resolve(result))),
      new Promise((resolve, reject) =>
        client.query(query('select count(*) from ' +
          `"${typeMap[type] || type}" ${where}`, parameters),
          parameters.length ? parameters : null,
          (error, result) => error ? reject(error) : resolve(result)))
    ])

    .then(results => {
      const records = results[0].rows.map(outputRecord.bind(this, type))
      records.count = parseInt(results[1].rows[0].count, 10)
      return records
    })

    function mapValueCast (value) {
      index++
      parameters.push(value)
      return `$${index}${Buffer.isBuffer(value) ? '::bytea' : ''}`
    }

    function mapValue (value) {
      index++
      parameters.push(value)
      return `$${index}`
    }
  }


  create (type, records) {
    if (!records.length) return super.create()

    records = records.map(inputRecord.bind(this, type))

    const Promise = this.Promise
    const client = this.client
    const recordTypes = this.recordTypes
    const typeMap = this.options.typeMap
    const primaryKey = this.keys.primary
    const ConflictError = this.errors.ConflictError

    // Need to know if we should let Postgres handle ID generation or not.
    const hasPrimaryKey = records.every(record => primaryKey in record)

    // The sort order here doesn't really matter, as long as it's consistent.
    const orderedFields = Object.keys(recordTypes[type]).sort()

    const parameters = []
    let index = 0

    /* eslint-disable prefer-template */
    const createRecords =
      (!hasPrimaryKey ? 'with inserted as (' : '') +
      ` insert into "${typeMap[type] || type}" (` +
      (hasPrimaryKey ? [ `"${primaryKey}"` ] : [])
      .concat(orderedFields.map(field => `"${field}"`))
      .join(', ') + ') values ' + records.map(record => {
        if (hasPrimaryKey) parameters.push(record[primaryKey])
        Array.prototype.push.apply(parameters, orderedFields
          .map(field => record[field]))

        return `(${(hasPrimaryKey ?
          [ primaryKey ].concat(orderedFields) : orderedFields).map(() => {
            index++
            return `$${index}`
          }).join(', ')})`
      }).join(', ') + (!hasPrimaryKey ?
        ` returning ${primaryKey}) select id from inserted` : '')
    /* eslint-enable prefer-template */

    return new Promise((resolve, reject) =>
      client.query(createRecords, parameters, (error, result) => {
        if (error) {
          const code = getCode(error)

          // Cryptic SQL error state that means unique constraint violated.
          // http://www.postgresql.org/docs/9.4/static/errcodes-appendix.html
          if (code === '23505')
            return reject(new ConflictError('Unique constraint violated.'))

          return reject(error)
        }

        if (!hasPrimaryKey)
          result.rows.forEach((result, i) => {
            records[i][primaryKey] = result[primaryKey]
          })

        return resolve(records.map(outputRecord.bind(this, type)))
      }))
  }


  update (type, updates) {
    const Promise = this.Promise
    const client = this.client
    const typeMap = this.options.typeMap
    const primaryKey = this.keys.primary

    // This is a little bit wrong, it is only safe to update within a
    // transaction. It's not possible to put it all in one update statement,
    // since the updates may be sparse.
    return Promise.all(updates.map(update => new Promise((resolve, reject) => {
      const parameters = []
      let index = 0
      let set = []

      for (const field in update.replace) {
        const value = update.replace[field]
        index++
        if (Array.isArray(value)) parameters.push(value.map(inputValue))
        else parameters.push(value)
        set.push(`"${field}" = $${index}`)
      }

      for (const field in update.push) {
        const value = update.push[field]
        index++

        if (Array.isArray(value)) {
          parameters.push(value.map(inputValue))
          set.push(`"${field}" = array_cat("${field}", $${index})`)
          continue
        }

        parameters.push(value)
        set.push(`"${field}" = array_append("${field}", $${index})`)
      }

      for (const field in update.pull) {
        const value = update.pull[field]

        if (Array.isArray(value)) {
          // This array removal query is a modification from here:
          // http://www.depesz.com/2012/07/12/
          // waiting-for-9-3-add-array_remove-and-array_replace-functions/
          set.push(`"${field}" = array(select x from unnest("${field}") ` +
            `x where x not in (${value.map(mapValue).join(', ')}))`)
          continue
        }

        index++
        parameters.push(value)
        set.push(`"${field}" = array_remove("${field}", $${index})`)
      }


      set = `set ${set.join(', ')}`

      index++
      parameters.push(update[primaryKey])
      const updateRecord = `update "${typeMap[type] || type}" ${set} ` +
        `where "${primaryKey}" = $${index}`

      client.query(updateRecord, parameters, (error, result) => {
        if (error) {
          const code = getCode(error)

          // If the record didn't exist, it's not an error.
          // http://www.postgresql.org/docs/9.4/static/errcodes-appendix.html
          if (code === '42703') return resolve(0)

          return reject(error)
        }

        return resolve(result.rowCount)
      })

      function mapValue (value) {
        index++
        parameters.push(value)
        return `$${index}`
      }
    })))
    .then(results => {
      return results.reduce((num, result) => {
        num += result
        return num
      }, 0)
    })
  }


  delete (type, ids) {
    if (ids && !ids.length) return super.delete()

    const Promise = this.Promise
    const client = this.client
    const typeMap = this.options.typeMap
    const primaryKey = this.keys.primary
    let index = 0

    /* eslint-disable prefer-template */
    const deleteRecords =
      `delete from "${typeMap[type] || type}"` +
      (ids ? ` where "${primaryKey}" in ` +
        `(${ids.map(() => {
          index++
          return `$${index}`
        }).join(', ')})` : '')
    /* eslint-enable prefer-template */

    return new Promise((resolve, reject) =>
      client.query(deleteRecords, ids ? ids : null,
        (error, result) => error ? reject(error) : resolve(result.rowCount)))
  }


  beginTransaction () {
    var mysqlConnection = mysql.createConnection(this.options.url);
    return new Promise((resolve, reject) =>
      mysqlConnection.connect(this.options.url, error => {
        if (error) return reject(error)

        var client = mysqlConnection;

        const scope = Object.create(Object.getPrototypeOf(this))

        Object.assign(scope, this, {
          client,
          endTransaction (error) {
            return new Promise((resolve, reject) =>
              client.query(error ? 'rollback' : 'commit',
                error ? reject(error) : resolve()))
          }
        })

        return client.query('begin', error =>
          error ? reject(error) : resolve(scope))
      }))
  }

}
