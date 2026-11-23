package schema
manifest: #AppManifest & {
 app_id:"integration-quickbooks"
 customer_id:"tenant-a"
 version:"quickbooks-test-v1"
 models:[
 {id:"supplier",kind:"entity",label:"Supplier",fields:[
 {id:"name",label:"Name",type:"text",required:true},
 {id:"status",label:"Status",type:"enum",required:true,option_set:[{id:"active",label:"Active"},{id:"inactive",label:"Inactive"}]},
 {id:"entity",label:"Entity",type:"text"},
 ]},
 {id:"payable",kind:"entity",label:"Payable",fields:[
 {id:"vendor",label:"Vendor",type:"relation",target_model:"supplier",required:true},
 {id:"amount",label:"Amount",type:"number",required:true},
 {id:"currency",label:"Currency",type:"iso_currency",required:true},
 {id:"date",label:"Date",type:"date",required:true},
 {id:"updated",label:"Updated",type:"datetime",required:true},
 {id:"open",label:"Open",type:"number"},
 {id:"due",label:"Due",type:"date"},
 {id:"kind",label:"Kind",type:"enum",required:true,option_set:[{id:"bill",label:"Bill"},{id:"credit",label:"Credit"}]},
 ]},
 ]
}
